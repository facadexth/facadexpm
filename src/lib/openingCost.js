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
function preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm }) {
  const sash = Number(sashThicknessMm)
  const thicknessMmByFamily = {}
  for (const lines of Object.values((model && model.lines) || {})) {
    for (const l of lines || []) {
      const f = String(l.profile_family ?? '').trim()
      if (f && !(f in thicknessMmByFamily)) thicknessMmByFamily[f] = l.thickness_role === 'sash' && allowMixed && sash > 0 ? sash : thicknessMm
    }
  }
  const opts = { index, seriesId, thicknessMmByFamily, thicknessMm }
  const { components, issues } = expandParts({ model, buttOf: buttOfFor(opts), widthOf: widthOfFor(opts) })
  return {
    components: applyRoleThickness(components, { allowMixed, sashThicknessMm }),
    issues: issues.map(i => (i.reason === 'no_model' && !i.role_name ? { ...i, role_name: template.name || '' } : i)),
  }
}

function prepareComponents({ template, components, joints, partModelByTemplate, index, seriesId, thicknessMm, sashThicknessMm }) {
  const allowMixed = template.type_id ? allowsMixedThickness(index, seriesId, template.type_id) : false
  if (template.layout_kind) {
    const model = (partModelByTemplate && partModelByTemplate[template.id]) || null
    return preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm })
  }
  return applyJoints({ components: applyRoleThickness(components, { allowMixed, sashThicknessMm }), joints, index, seriesId, thicknessMm })
}

// ctx: { item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate,
//        typesById, infillTypesById, index, settings, asOf, packageItems?, partModelByTemplate? }
// partModelByTemplate: { [templateId]: model } (partSave.modelFromRows) for templates with layout_kind; ignored otherwise.
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
  const prepared = prepareComponents({ template, components: byT(ctx.componentsByTemplate, template.id), joints: byT(ctx.jointsByTemplate, template.id), partModelByTemplate: ctx.partModelByTemplate, index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
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
