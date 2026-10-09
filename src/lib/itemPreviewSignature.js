// src/lib/itemPreviewSignature.js
// ONE place that turns an item row (or the item form's payload, which has the same shape and normalised values)
// into the preview inputs and the preview signature. The item form calls it when it saves the snapshot, and the
// project's items table calls it for the "ภาพเก่า" status, so the two can never disagree. Pure.
import { buildFramePreview, previewSvgString, previewSignature } from './framePreview.js'
import { resolveCatalogProfile } from './aluCatalogPricing.js'

const num = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const intOr1 = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? n : 1 }
const positive = v => { const n = num(v); return n !== null && n > 0 ? n : null }
const axisOf = t => (t && t.main_axis === 'horizontal' ? 'horizontal' : 'vertical')
const isSet = v => !(v === null || v === undefined || String(v).trim() === '')
const WIDTH_OR_HEIGHT = new Set(['width', 'height', 'width_minus', 'height_minus'])

// The profile family drawn as the frame: the main bar of the template's first joint (by sort_order), else the
// first frame-role (not sash) component cut along the width or height. null when the template says neither.
export function mainFrameFamily(components, joints) {
  const j = [...(joints || [])].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .find(x => String(x.main_family ?? '').trim())
  if (j) return String(j.main_family).trim()
  const c = (components || []).find(x => x.thickness_role !== 'sash' && String(x.profile_family ?? '').trim() && WIDTH_OR_HEIGHT.has(x.length_rule_type))
  return c ? String(c.profile_family).trim() : null
}

function frameWidthMm(template, ctx, seriesId, thicknessMm) {
  if (!template || !seriesId || !(Number(thicknessMm) > 0) || !ctx.index) return null
  const fam = mainFrameFamily((ctx.componentsByTemplate || {})[template.id], (ctx.jointsByTemplate || {})[template.id])
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

// Signature of everything that changes the saved drawing, from the row's values + both templates + frame widths.
export function itemPreviewSignature(item, template, addonTemplate, resolved) {
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
export function snapshotPreviews(item, template, addonTemplate, resolved, views = { out: true, in: true }) {
  if (!views || (!views.out && !views.in)) return null
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
