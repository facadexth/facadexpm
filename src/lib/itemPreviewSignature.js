// src/lib/itemPreviewSignature.js
// ONE place that turns an item row (or the item form's payload, which has the same shape and normalised values)
// into the preview inputs and the preview signature. The item form calls it when it saves the snapshot, and the
// project's items table calls it for the "ภาพเก่า" status, so the two can never disagree. Pure.
import { buildFramePreview, previewSvgString, previewSignature } from './framePreview.js'
import { resolveCatalogProfile } from './aluCatalogPricing.js'
import { resolveItemInputs } from './estimationInherit.js'
import { partSvgString, drawnWidths } from './partPreviewSvg.js'
import { LAYOUTS } from './partModel.js'
import { partPreviewCtx } from './openingCost.js'

const num = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const intOr1 = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? n : 1 }
const positive = v => { const n = num(v); return n !== null && n > 0 ? n : null }
const axisOf = t => (t && t.main_axis === 'horizontal' ? 'horizontal' : 'vertical')
const isSet = v => !(v === null || v === undefined || String(v).trim() === '')
const WIDTH_OR_HEIGHT = new Set(['width', 'height', 'width_minus', 'height_minus'])

// The ONE frame picker (the drawing's frame width and the "parts" labels both use it): the profile family of the
// frame bars = non-sash components (thickness_role NULL) cut along the width or height (head, sill, jamb). Among
// several such families a joint's main_family decides (first joint by sort_order whose main family is one of
// them; a joint whose main family only sash bars use is ignored); otherwise the first one. null = no frame bar.
export function frameFamily(components, joints) {
  const fams = []
  for (const c of components || []) {
    const f = String(c.profile_family ?? '').trim()
    if (f && c.thickness_role !== 'sash' && WIDTH_OR_HEIGHT.has(c.length_rule_type) && !fams.includes(f)) fams.push(f)
  }
  if (!fams.length) return null
  const j = [...(joints || [])].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .find(x => fams.includes(String(x.main_family ?? '').trim()))
  return j ? String(j.main_family).trim() : fams[0]
}

function frameWidthMm(template, ctx, seriesId, thicknessMm) {
  if (!template || !seriesId || !(Number(thicknessMm) > 0) || !ctx.index) return null
  const fam = frameFamily((ctx.componentsByTemplate || {})[template.id], (ctx.jointsByTemplate || {})[template.id])
  if (!fam) return null
  const { profile } = resolveCatalogProfile(ctx.index, seriesId, fam, Number(thicknessMm))
  return profile ? positive(profile.width_mm) : null
}

// { frame_mm, addon_frame_mm }: the visible width (mm) of each unit's frame profile in the series/thickness the
// item resolves to (the add-on uses the main item's series and thickness); null when unknown (the drawing then
// uses its default frame width). ctx: { index, componentsByTemplate, jointsByTemplate }.
export function previewFrames({ template, addonTemplate, ctx, seriesId, thicknessMm }) {
  const c = ctx || {}
  return {
    frame_mm: frameWidthMm(template, c, seriesId, thicknessMm),
    addon_frame_mm: addonTemplate ? frameWidthMm(addonTemplate, c, seriesId, thicknessMm) : null,
  }
}

const hasAddon = (item, addonTemplate) => !!(isSet(item.addon_template_id) && addonTemplate && positive(item.addon_width_m) && positive(item.addon_height_m))

// The buildFramePreview argument (without view / part_labels) for an item row. resolved = previewFrames(...).
export function itemPreviewInputs(item, template, addonTemplate, resolved) {
  const it = item || {}
  const r = resolved || {}
  return {
    template,
    width_m: num(it.width_m), height_m: num(it.height_m), panel_count: intOr1(it.panel_count),
    main_axis: axisOf(template),
    frame_mm: positive(r.frame_mm) ?? undefined,
    addon: hasAddon(it, addonTemplate) ? {
      template: addonTemplate, width_m: num(it.addon_width_m), height_m: num(it.addon_height_m), panel_count: intOr1(it.addon_panel_count),
      position: it.addon_position || 'top', offset_m: num(it.addon_offset_m), frame_mm: positive(r.addon_frame_mm) ?? undefined, main_axis: axisOf(addonTemplate),
    } : null,
  }
}

// The part model the item is drawn from, or null for the legacy drawing. Only a layout_kind template WITHOUT an add-on
// (as the legacy drawing counts one) and with a drawable model in partCtx = { model, buttOf, widthOf? } uses it.
export function partPreviewModel(item, template, addonTemplate, partCtx) {
  if (!template || !template.layout_kind || hasAddon(item || {}, addonTemplate)) return null
  const m = partCtx && partCtx.model
  return m && typeof m === 'object' && LAYOUTS[m.layout_kind] && m.lines && Array.isArray(m.parts) ? m : null
}

// JSON with sorted object keys at every level, so a model loaded in another key order signs the same.
const stableJson = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x))

// Fingerprint of the part drawing's inputs beyond the legacy signature: the whole model (layout_kind, end modes,
// deduction overrides, names...) and the catalogue widths the drawing is scaled with. Exact: the drawing ignores butt
// distances (partPreviewSvg.js), so a catalogue butt-distance change alone does not make the saved drawing old.
// model.done (the editor's "เสร็จแล้ว" ticks) is UI-only and never changes the drawing, so it is left out of the signature.
function partFingerprint(model, partCtx) {
  const { done, ...drawn } = model   // eslint-disable-line no-unused-vars
  return stableJson([model.layout_kind, drawn, drawnWidths(model, partCtx.widthOf)])
}

// Signature of everything that changes the saved drawing, from the row's values + both templates + frame widths.
// partCtx (optional): when the item is drawn from a part model (partPreviewModel) its fingerprint is appended; the legacy
// signature string is unchanged otherwise.
// partCtx.addons (inline add-ons, mm, the list the drawing draws) append addonSignature(...) when non-empty.
export function itemPreviewSignature(item, template, addonTemplate, resolved, partCtx) {
  const legacy = legacySignature(item, template, addonTemplate, resolved)
  const model = partPreviewModel(item, template, addonTemplate, partCtx)
  return model ? `${legacy}|part:${partFingerprint(model, partCtx)}${addonSignature(partCtx.addons)}` : legacy
}

// The inline add-ons' part of the signature: '' for none, else '|ao:' + JSON of the list with exactly the drawn fields in
// a fixed key order (numbers as numbers; align defaults to 'start', offset to 0, as layoutAddons reads them). The ONE
// helper both the item form (snapshotFor, live add-ons) and the items table (currentPreviewSigs, saved add-ons) sign with.
const AO_NUM = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)
export function addonSignature(addons) {
  if (!Array.isArray(addons) || !addons.length) return ''
  return '|ao:' + JSON.stringify(addons.map(a => ({
    mode: a?.mode ?? null, kind: a?.kind ?? null, position: a?.position ?? null,
    len_mm: AO_NUM(a?.len_mm), thick_mm: AO_NUM(a?.thick_mm), offset_mm: AO_NUM(a?.offset_mm) ?? 0,
    align: a?.align === 'end' ? 'end' : 'start', rows: AO_NUM(a?.rows), cols: AO_NUM(a?.cols),
  })))
}

function legacySignature(item, template, addonTemplate, resolved) {
  const it = item || {}
  const r = resolved || {}
  const a = isSet(it.addon_template_id)
  return previewSignature({
    template_id: it.template_id ?? null, width_m: it.width_m, height_m: it.height_m, panel_count: intOr1(it.panel_count),
    addon_template_id: a ? it.addon_template_id : null, addon_width_m: it.addon_width_m, addon_height_m: it.addon_height_m,
    addon_panel_count: intOr1(it.addon_panel_count), addon_position: it.addon_position || 'top', addon_offset_m: it.addon_offset_m,
    main_axis: axisOf(template), frame_mm: positive(r.frame_mm), addon_frame_mm: positive(r.addon_frame_mm),
    preview_kind: (template && template.preview_kind) || 'fixed', grid_row_weights: template ? template.grid_row_weights : null,
    addon_preview_kind: addonTemplate ? addonTemplate.preview_kind || 'fixed' : null,
    addon_grid_row_weights: addonTemplate ? addonTemplate.grid_row_weights : null,
    addon_main_axis: addonTemplate ? axisOf(addonTemplate) : null,
  })
}

// The saved snapshot: always the double-line drawing, never part labels. views: { out, in } booleans.
// Returns { out, in, sig } for buildOpeningPayload, or null when nothing can (or should) be saved.
// partCtx (optional, { model, buttOf, widthOf?, addons?, overrides? }): a layout_kind template without (legacy) add-on is drawn
// by partSvgString (the part editor's overview, with its inline add-ons); everything else takes the legacy path as before.
export function snapshotPreviews(item, template, addonTemplate, resolved, views = { out: true, in: true }, partCtx = null) {
  if (!views || (!views.out && !views.in)) return null
  const model = partPreviewModel(item, template, addonTemplate, partCtx)
  if (model) {
    const it = item || {}
    const w = positive(it.width_m), h = positive(it.height_m)
    if (!w || !h) return null
    const mm = m => Math.round(m * 1e6) / 1e3
    const draw = view => partSvgString({ model, widthMm: mm(w), heightMm: mm(h), view, buttOf: partCtx.buttOf, widthOf: partCtx.widthOf, style: 'double', addons: partCtx.addons || null, overrides: partCtx.overrides || null })
    const out = views.out ? draw('out') : null
    const inn = views.in ? draw('in') : null
    if (!out && !inn) return null
    return { out, in: inn, sig: itemPreviewSignature(item, template, addonTemplate, resolved, partCtx) }
  }
  const inputs = itemPreviewInputs(item, template, addonTemplate, resolved)
  const draw = view => {
    const p = buildFramePreview({ ...inputs, view })
    return p ? previewSvgString(p, { style: 'double' }) : null
  }
  const out = views.out ? draw('out') : null
  const inn = views.in ? draw('in') : null
  if (!out && !inn) return null
  return { out, in: inn, sig: itemPreviewSignature(item, template, addonTemplate, resolved) }
}

// The snapshot of a row as the item form saves it (the row = the payload, metres): frames from the series and
// thickness the row resolves to. ctx = the costOpening context (templatesById, index, packageItems, components, joints,
// partModelByTemplate — a layout_kind template is drawn from its part model, see partPreviewCtx).
// addons (optional, mm): the inline add-ons to draw and sign — the item form passes its live ones (the payload has no
// id yet); omitted, a saved row takes its saved ones from ctx.itemAddonsByOpening[row.id] (partPreviewCtx / addonPlan),
// exactly what currentPreviewSigs signs.
export function snapshotFor(row, { project, ctx, views, addons }) {
  const tpl = ctx.templatesById[row.template_id] || null
  if (!tpl) return null
  const atpl = row.addon_template_id ? ctx.templatesById[row.addon_template_id] || null : null
  const r = resolveItemInputs(row, project, tpl, ctx.index.types, ctx.packageItems)
  const frames = previewFrames({ template: tpl, addonTemplate: atpl, ctx, seriesId: r.series_id, thicknessMm: r.thickness_mm })
  const partCtx = partPreviewCtx(ctx, tpl, r, row)
  return snapshotPreviews(row, tpl, atpl, frames, views, partCtx && addons !== undefined ? { ...partCtx, addons: Array.isArray(addons) ? addons : [] } : partCtx)
}
