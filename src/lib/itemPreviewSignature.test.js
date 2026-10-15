import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { emptyForm, buildOpeningPayload } from './openingPayload.js'
import { frameFamily, previewFrames, itemPreviewInputs, itemPreviewSignature, snapshotPreviews, snapshotFor, addonSignature } from './itemPreviewSignature.js'
import golden from './itemPreviewSignature.golden.json'
import { partSvgString } from './partPreviewSvg.js'
import { startModel, setEndMode, updateEnd } from './partModel.js'

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

// ---- Task 10: part-editor drawing for layout_kind templates --------------------------------------------------

describe('part-editor drawing in the saved snapshot (layout_kind templates)', () => {
  const tp = { id: 'tPart', main_axis: 'horizontal', preview_kind: 'slide', grid_row_weights: [1], layout_kind: 'sliding_2' }
  const model = (() => {
    const m = startModel('sliding_2')
    for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = k.startsWith('frame') ? 'FR' : 'SA'
    return m
  })()
  const partCtx = { model, buttOf: () => 20 }
  const row = { template_id: 'tPart', width_m: 1.8, height_m: 1.2, panel_count: 2 }
  const rowA = { template_id: 'tPart', width_m: 1.8, height_m: 1.2, panel_count: 2, addon_template_id: 'tFix', addon_width_m: 1.8, addon_height_m: 0.4, addon_position: 'top', addon_panel_count: 1 }

  it('(d) legacy templates: snapshot strings and signature are byte-identical to before Task 10', () => {
    const legacyRow = { template_id: 'tSlide', width_m: 1.5, height_m: 1, panel_count: 2 }
    expect(snapshotPreviews(legacyRow, slide, null, { frame_mm: 44.45 })).toEqual(golden.legacy)
    expect(snapshotPreviews(legacyRow, slide, null, { frame_mm: 44.45 }, undefined, partCtx)).toEqual(golden.legacy)
    expect(itemPreviewSignature(legacyRow, slide, null, { frame_mm: 44.45 }, partCtx)).toBe(golden.legacy.sig)
  })

  it('(e) layout_kind without add-on → part drawing; with an add-on → the legacy strings and signature', () => {
    const snap = snapshotPreviews(row, tp, null, { frame_mm: null }, { out: true, in: true }, partCtx)
    expect(snap.out).toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' }))
    expect(snap.in).toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'in' }))
    expect(snap.sig).toBe(itemPreviewSignature(row, tp, null, { frame_mm: null }, partCtx))
    expect(snap.sig).not.toBe(itemPreviewSignature(row, tp, null, { frame_mm: null }))
    expect(snapshotPreviews(row, tp, null, { frame_mm: null }, { out: false, in: true }, partCtx).out).toBeNull()
    expect(snapshotPreviews({ ...row, width_m: null }, tp, null, {}, undefined, partCtx)).toBeNull()
    expect(snapshotPreviews(rowA, tp, fixed, { frame_mm: null }, undefined, partCtx)).toEqual(golden.layoutAddon)
    // no model in the context → legacy path
    expect(snapshotPreviews(rowA, tp, fixed, { frame_mm: null }, undefined, { model: null })).toEqual(golden.layoutAddon)
  })

  it('(f) the signature follows end modes, deduction overrides and drawn widths; not an unused butt distance', () => {
    const sig = m => itemPreviewSignature(row, tp, null, { frame_mm: null }, m)
    const base = sig(partCtx)
    expect(sig({ model: JSON.parse(JSON.stringify(model)), buttOf: () => 20 })).toBe(base)
    // key order of the stored model does not matter
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(model))).reverse())
    expect(sig({ model: reordered, buttOf: () => 20 })).toBe(base)
    expect(sig({ ...partCtx, model: setEndMode(model, 'frame_top', 0, 0, 0, 'through') })).not.toBe(base)
    expect(sig({ ...partCtx, model: updateEnd(model, 'frame_top', 0, 0, 0, { deduction_mm: 7 }) })).not.toBe(base)
    // the drawing ignores butt distances: a catalogue butt-distance change alone keeps the saved drawing current
    expect(sig({ ...partCtx, buttOf: () => 21 })).toBe(base)
    // a drawn (catalogue) profile width changes the drawing, so the signature
    const wide = sig({ ...partCtx, widthOf: f => (f === 'FR' ? 50 : 40) })
    expect(wide).not.toBe(base)
    expect(sig({ ...partCtx, widthOf: f => (f === 'FR' ? 50 : 40) })).toBe(wide)
    expect(sig({ ...partCtx, widthOf: f => (f === 'FR' ? 51 : 40) })).not.toBe(wide)
    expect(sig({ ...partCtx, model: { ...model, layout_kind: 'other' } })).not.toBe(base)
    // stored row (strings) gives the same signature as the save-time payload
    expect(itemPreviewSignature({ ...row, width_m: '1.8', height_m: '1.2' }, tp, null, { frame_mm: null }, partCtx)).toBe(base)
  })

  it('snapshotFor wires the costing context (partModelByTemplate) into the part drawing', () => {
    const c = { ...ctx, templatesById: { tPart: tp }, packageItems: null, partModelByTemplate: { tPart: model } }
    c.index = { ...index, types: {} }
    const snap = snapshotFor(row, { project: {}, ctx: c, views: { out: true, in: true } })
    expect(snap.out).toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' }))
  })

  it('snapshot draws with partCtx.widthOf (true-scale bars)', () => {
    const widthOf = f => (f === 'FR' ? 60 : 45)
    const snap = snapshotPreviews(row, tp, null, {}, undefined, { ...partCtx, widthOf })
    expect(snap.out).toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out', widthOf }))
    expect(snap.out).not.toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out' }))
  })
})

describe('"เสร็จแล้ว" ticks do not make saved drawings stale (Task 10 fix round 1)', () => {
  it('two models differing only in done sign the same; a real change still differs', () => {
    const tpl = { id: 'tA', layout_kind: 'awning_grid', main_axis: 'vertical', preview_kind: 'fixed', grid_row_weights: [1] }
    const row = { template_id: 'tA', width_m: 1.8, height_m: 1.2, panel_count: 1 }
    const m = startModel('awning_grid', { rows: 2, cols: 2 })
    const sig = (model) => itemPreviewSignature(row, tpl, null, { frame_mm: null }, { model, buttOf: () => 20 })
    expect(sig({ ...m, done: ['frame', 'sash'] })).toBe(sig(m))
    expect(sig({ ...m, done: ['sash'] })).toBe(sig({ ...m, done: [] }))
    expect(sig(setEndMode(m, 'frame_top', 0, 0, 0, 'through'))).not.toBe(sig(m))
  })
})

// ---- inline add-ons (ช่องแสง) in the drawing and the signature -------------------------------------------------
describe('inline add-ons in the saved snapshot and its signature', () => {
  const tp = { id: 'tPart', main_axis: 'horizontal', preview_kind: 'slide', grid_row_weights: [1], layout_kind: 'sliding_2' }
  const model = (() => {
    const m = startModel('sliding_2')
    for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = k.startsWith('frame') ? 'FR' : 'SA'
    return m
  })()
  const row = { template_id: 'tPart', width_m: 1.8, height_m: 1.2, panel_count: 2 }
  const top = { mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3 }
  const sig = (addons, extra = {}) => itemPreviewSignature(row, tp, null, { frame_mm: null }, { model, buttOf: () => 20, addons, ...extra })

  it('no add-ons ⇒ the signature string is unchanged; with add-ons it ends in |ao: + the list in fixed key order', () => {
    const plain = itemPreviewSignature(row, tp, null, { frame_mm: null }, { model, buttOf: () => 20 })
    expect(sig([])).toBe(plain)
    expect(sig(null)).toBe(plain)
    expect(addonSignature([])).toBe('')
    expect(addonSignature(null)).toBe('')
    expect(sig([top])).toBe(plain + addonSignature([top]))
    expect(addonSignature([{ cols: '3', rows: 1, align: 'start', offset_mm: 0, thick_mm: '400', len_mm: 1800, position: 'top', kind: 'fixed', mode: 'merge', id: 'x' }]))
      .toBe('|ao:[{"mode":"merge","kind":"fixed","position":"top","len_mm":1800,"thick_mm":400,"offset_mm":0,"align":"start","rows":1,"cols":3}]')
  })
  it('changes with every add-on field, not with an unrelated catalogue value (butt distance)', () => {
    const base = sig([top])
    const changes = { mode: 'attach', kind: 'awning', position: 'bottom', len_mm: 1700, thick_mm: 450, offset_mm: 10, align: 'end', rows: 2, cols: 4 }
    for (const [k, v] of Object.entries(changes)) expect(sig([{ ...top, [k]: v }])).not.toBe(base)
    expect(sig([top, top])).not.toBe(base)
    expect(sig([top], { buttOf: () => 33 })).toBe(base)
  })
  it('snapshotPreviews draws the add-ons from partCtx; snapshotFor takes them explicitly (item form)', () => {
    const partCtx = { model, buttOf: () => 20, addons: [top] }
    const snap = snapshotPreviews(row, tp, null, { frame_mm: null }, undefined, partCtx)
    expect(snap.out).toBe(partSvgString({ model, widthMm: 1800, heightMm: 1200, view: 'out', addons: [top] }))
    expect(snap.in).toContain('1800 × 1600')
    expect(snap.sig).toContain('|ao:')
    const c = { ...ctx, templatesById: { tPart: tp }, packageItems: null, partModelByTemplate: { tPart: model } }
    c.index = { ...index, types: {} }
    const formSnap = snapshotFor(row, { project: {}, ctx: c, views: { out: true, in: true }, addons: [top] })
    expect(formSnap.out).toBe(snap.out)
    expect(formSnap.sig).toBe(snap.sig)
    // the resave path: a saved item (id) takes its saved add-ons from the context
    const saved = snapshotFor({ ...row, id: 'o1' }, { project: {}, ctx: { ...c, itemAddonsByOpening: { o1: [top] }, addonPiecesByTemplate: {} }, views: { out: true, in: true } })
    expect(saved.out).toBe(snap.out)
    expect(saved.sig).toBe(snap.sig)
    // a legacy (non layout_kind) template never draws or signs inline add-ons
    expect(snapshotFor({ ...row, template_id: 'tSlide' }, { project: {}, ctx: { ...c, templatesById: { tSlide: slide } }, views: { out: true, in: true }, addons: [top] }).sig).not.toContain('|ao:')
  })
})
