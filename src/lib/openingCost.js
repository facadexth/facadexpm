// src/lib/openingCost.js
// One item, fully costed: resolves inherited inputs, applies the template's joints and role thickness,
// prices main + add-on through the catalog, and adds the accessory extras. The item form, the project BOM,
// the stale-price check and the quick calculator all call this, so they cannot disagree. Pure.
import { computeBomForOpening, combineOpeningBoms } from './bomEngine.js'
import { makeCatalogPricing } from './aluCatalogPricing.js'
import { resolveItemInputs, buildEngineOpening, buildEngineAddonOpening } from './estimationInherit.js'
import { applyJoints, applyRoleThickness, jointDeductionMm } from './assembly.js'
import { resolveCatalogProfile } from './aluCatalogPricing.js'
import { expandParts } from './partExpand.js'
import { allowsMixedThickness } from './estimationCatalogViews.js'
import { openingExtras } from './openingExtras.js'
import { setParams } from './partModel.js'
import { coerceParams, inputsOf } from './layoutRegistry.js'

const positive = n => Number.isFinite(Number(n)) && Number(n) > 0

const numOrNull = v => (v === null || v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// The catalog profile of `family` at the item's series and the family's thickness (thicknessMmByFamily, else thicknessMm).
function profileFor({ index, seriesId, thicknessMmByFamily, thicknessMm }, family) {
  const fam = String(family ?? '').trim()
  const t = (thicknessMmByFamily && thicknessMmByFamily[fam] != null) ? thicknessMmByFamily[fam] : thicknessMm
  if (!index || !seriesId || !fam || !(Number(t) > 0)) return null
  return resolveCatalogProfile(index, seriesId, fam, Number(t)).profile
}

// Ruling PE-4: butt distance (mm) of a family = alu_profiles.butt_distance_mm, else the legacy automatic joint rule
// (assembly.jointDeductionMm: depth for a wide-face contact, width for a narrow one), else null (partExpand then lists
// no_butt_distance). Returns family -> mm | null.
export function buttOfFor(opts) {
  return family => {
    const p = profileFor(opts, family)
    if (!p) return null
    const own = numOrNull(p.butt_distance_mm)
    if (own !== null && own >= 0) return own
    return jointDeductionMm({ deduction_mode: 'auto', cut_style: 'square' }, p).mm
  }
}

// family -> the resolved profile's full width_mm | null (the hook-stile overlap fallback, Ruling PE-5).
export function widthOfFor(opts) {
  return family => {
    const w = numOrNull(profileFor(opts, family)?.width_mm)
    return w !== null && w > 0 ? w : null
  }
}

// A part-model template (layout_kind set): components come from its model (Ruling PE-2), role thickness applies as for
// flat components, joints do not (expanded rows carry no joint_id). The expander's issues travel the joint-issue path.
// The profile lookup options of a part model: each family at its role's thickness (sash role → the sash thickness when the
// series allows mixed thickness). Shared by costing and the item preview (partPreviewCtx), so both see the same butt distances.
function partFamilyOpts({ model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm }) {
  const sash = Number(sashThicknessMm)
  const thicknessMmByFamily = {}
  for (const lines of Object.values((model && model.lines) || {})) {
    for (const l of lines || []) {
      const f = String(l.profile_family ?? '').trim()
      if (f && !(f in thicknessMmByFamily)) thicknessMmByFamily[f] = l.thickness_role === 'sash' && allowMixed && sash > 0 ? sash : thicknessMm
    }
  }
  return { index, seriesId, thicknessMmByFamily, thicknessMm }
}

// The template's model as this item uses it: the item's estimation_openings.layout_params (coerced) override the
// template's params for inputs marked `estimator` and not `fixed_by_type` only (a fixed_by_type input such as awning
// rows/cols is the type's; anything else is the template's). Returns the same model object when nothing changes, a
// new one (setParams: piece counts and factors follow) otherwise, { error: 'layout_params_invalid' } when the layout
// refuses the combination, and the input unchanged for a missing / refused model.
export function modelForItem(model, item) {
  if (!model || model.error || !model.layout_kind) return model
  const lp = coerceParams(model.layout_kind, item && item.layout_params)
  const patch = {}
  for (const inp of inputsOf(model.layout_kind)) {
    if (!inp.estimator || inp.fixed_by_type || !(inp.key in lp)) continue
    if (JSON.stringify(lp[inp.key]) !== JSON.stringify((model.params || {})[inp.key])) patch[inp.key] = lp[inp.key]
  }
  if (!Object.keys(patch).length) return model
  try { return setParams(model, patch) } catch (e) {
    if (e && e.message === 'layout_params_invalid') return { error: 'layout_params_invalid' }
    throw e
  }
}

// Glass / panel parts (frameless leaves and panes: part.glass; curtain-wall spandrels: part.panel) have no positions,
// so they expand to no aluminium rows. Their infill (glassParts / layoutCells.panelCells) is NOT priced here yet: a
// later infill task prices it from those helpers.
function preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm }) {
  // a model refused at load (partSave: layout_mismatch / layout_params_invalid) or by the item's params
  if (model && model.error) return { components: [], issues: [{ role_name: template.name || '', reason: model.error }] }
  const opts = partFamilyOpts({ model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm })
  const { components, issues } = expandParts({ model, buttOf: buttOfFor(opts), widthOf: widthOfFor(opts) })
  return {
    components: applyRoleThickness(components, { allowMixed, sashThicknessMm }),
    issues: issues.map(i => (i.reason === 'no_model' && !i.role_name ? { ...i, role_name: template.name || '' } : i)),
  }
}

// item: the item whose layout_params apply (main template only; null for the add-on).
function prepareComponents({ template, components, joints, partModelByTemplate, index, seriesId, thicknessMm, sashThicknessMm, item = null }) {
  const allowMixed = template.type_id ? allowsMixedThickness(index, seriesId, template.type_id) : false
  if (template.layout_kind) {
    const model = modelForItem((partModelByTemplate && partModelByTemplate[template.id]) || null, item)
    return preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm })
  }
  return applyJoints({ components: applyRoleThickness(components, { allowMixed, sashThicknessMm }), joints, index, seriesId, thicknessMm })
}

// The item preview's part context of a layout_kind template: { model, buttOf, widthOf } exactly as costOpening expands it
// (same model, same per-family thickness), or null for a template without layout_kind or without a usable model.
// ctx = the costOpening context (index, partModelByTemplate); resolved = resolveItemInputs(...) of the item;
// item (optional) = the item, whose layout_params adjust the model as in costing (modelForItem).
export function partPreviewCtx(ctx, template, resolved, item = null) {
  if (!template || !template.layout_kind) return null
  const model = modelForItem((ctx && ctx.partModelByTemplate && ctx.partModelByTemplate[template.id]) || null, item)
  if (!model || model.error) return null
  const index = ctx.index
  const r = resolved || {}
  const allowMixed = template.type_id && index ? allowsMixedThickness(index, r.series_id, template.type_id) : false
  const opts = partFamilyOpts({ model, index, seriesId: r.series_id, thicknessMm: r.thickness_mm, allowMixed, sashThicknessMm: r.sash_thickness_mm })
  return { model, buttOf: buttOfFor(opts), widthOf: widthOfFor(opts) }
}

// ctx: { item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate,
//        typesById, infillTypesById, index, settings, asOf, packageItems?, partModelByTemplate? }
// partModelByTemplate: { [templateId]: model | { error } } (partSave.partModelsByTemplate) for templates with layout_kind;
// ignored otherwise. An { error } entry is reported by its reason (layout_mismatch ...), never priced.
// item.layout_params (estimation_openings) adjust the main template's model (modelForItem).
export function costOpening(ctx) {
  const { item: rawItem, project, template, addonTemplate, index, settings, asOf } = ctx
  // DB numerics can arrive as strings; the engine adds width + height, so coerce once here.
  const item = { ...rawItem, width_m: Number(rawItem.width_m) || 0, height_m: Number(rawItem.height_m) || 0, panel_count: Math.max(1, Math.floor(Number(rawItem.panel_count)) || 1) }
  const byT = (m, id) => (m && m[id]) || []
  // packageItems: rows of the project's chosen hardware package, or null/undefined when it has none
  const resolved = resolveItemInputs(item, project, template, ctx.typesById, ctx.packageItems)
  const pricing = makeCatalogPricing({ index, seriesId: resolved.series_id, finishId: resolved.finish_id, asOf })
  const issues = []
  const own = []
  if (!(item.width_m > 0 && item.height_m > 0)) own.push({ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' })
  if (resolved.infill_type_id && !(ctx.infillTypesById || {})[resolved.infill_type_id]) own.push({ name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' })

  const main = buildEngineOpening(item, project, template, ctx.typesById, ctx.infillTypesById, ctx.packageItems)
  const prepared = prepareComponents({ template, components: byT(ctx.componentsByTemplate, template.id), joints: byT(ctx.jointsByTemplate, template.id), partModelByTemplate: ctx.partModelByTemplate, index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm, item: rawItem })
  issues.push(...prepared.issues)
  const bom = computeBomForOpening(main.opening, template, prepared.components, byT(ctx.hardwareByTemplate, template.id), pricing, main.infillType)

  let addonBom = null
  const hasAddon = item.addon_template_id && addonTemplate && positive(item.addon_width_m) && positive(item.addon_height_m)
  if (hasAddon) {
    const addon = { width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m), panel_count: item.addon_panel_count || 1, quantity: 1, extra_lines: [] }
    const ao = buildEngineAddonOpening(item, project, addon, addonTemplate, ctx.typesById, ctx.infillTypesById)
    const aPrepared = prepareComponents({ template: addonTemplate, components: byT(ctx.componentsByTemplate, addonTemplate.id), joints: byT(ctx.jointsByTemplate, addonTemplate.id), partModelByTemplate: ctx.partModelByTemplate, index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
    issues.push(...aPrepared.issues)
    addonBom = computeBomForOpening(ao.opening, addonTemplate, aPrepared.components, byT(ctx.hardwareByTemplate, addonTemplate.id), pricing, ao.infillType)
  }

  // an add-on the item asks for but that could not be costed must be said, never silently left out of the total
  if (item.addon_template_id && !hasAddon) own.push({ name: 'ชุดต่อเติม', reason: addonTemplate ? 'no_dimension' : 'unknown_addon_template', source: 'addon' })

  const units = [{ width_m: Number(item.width_m), height_m: Number(item.height_m) }]
  if (hasAddon) units.push({ width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m) })
  const extras = openingExtras({ units, settings, partsById: index.parts, pricing })
  const combined = combineOpeningBoms(bom, addonBom)
  return {
    resolved, bom, addonBom, extras, issues,
    total: combined.totalCost + extras.cost,
    unresolved: [
      ...own,
      ...bom.unresolvedDetails.map(d => ({ ...d, source: 'main' })),
      ...(addonBom ? addonBom.unresolvedDetails.map(d => ({ ...d, source: 'addon' })) : []),
      ...extras.unresolved.map(d => ({ ...d, source: 'extras' })),
      ...issues.map(i => ({ name: i.role_name, reason: i.reason, source: 'joint' })),
    ],
  }
}
