// src/lib/openingCost.js
// One item, fully costed: resolves inherited inputs, applies the template's joints and role thickness,
// prices main + add-on through the catalog, and adds the accessory extras. The item form, the project BOM,
// the stale-price check and the quick calculator all call this, so they cannot disagree. Pure.
import { computeBomForOpening, combineOpeningBoms } from './bomEngine.js'
import { makeCatalogPricing } from './aluCatalogPricing.js'
import { resolveItemInputs, buildEngineOpening, buildEngineAddonOpening } from './estimationInherit.js'
import { applyJoints, applyRoleThickness } from './assembly.js'
import { allowsMixedThickness } from './estimationCatalogViews.js'
import { openingExtras } from './openingExtras.js'

const positive = n => Number.isFinite(Number(n)) && Number(n) > 0

function prepareComponents({ template, components, joints, index, seriesId, thicknessMm, sashThicknessMm }) {
  const allowMixed = template.type_id ? allowsMixedThickness(index, seriesId, template.type_id) : false
  return applyJoints({ components: applyRoleThickness(components, { allowMixed, sashThicknessMm }), joints, index, seriesId, thicknessMm })
}

// ctx: { item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate,
//        typesById, infillTypesById, index, settings, asOf }
export function costOpening(ctx) {
  const { item: rawItem, project, template, addonTemplate, index, settings, asOf } = ctx
  // DB numerics can arrive as strings; the engine adds width + height, so coerce once here.
  const item = { ...rawItem, width_m: Number(rawItem.width_m) || 0, height_m: Number(rawItem.height_m) || 0, panel_count: Math.max(1, Math.floor(Number(rawItem.panel_count)) || 1) }
  const byT = (m, id) => (m && m[id]) || []
  const resolved = resolveItemInputs(item, project, template, ctx.typesById)
  const pricing = makeCatalogPricing({ index, seriesId: resolved.series_id, finishId: resolved.finish_id, asOf })
  const issues = []
  const own = []
  if (!(item.width_m > 0 && item.height_m > 0)) own.push({ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' })
  if (resolved.infill_type_id && !(ctx.infillTypesById || {})[resolved.infill_type_id]) own.push({ name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' })

  const main = buildEngineOpening(item, project, template, ctx.typesById, ctx.infillTypesById)
  const prepared = prepareComponents({ template, components: byT(ctx.componentsByTemplate, template.id), joints: byT(ctx.jointsByTemplate, template.id), index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
  issues.push(...prepared.issues)
  const bom = computeBomForOpening(main.opening, template, prepared.components, byT(ctx.hardwareByTemplate, template.id), pricing, main.infillType)

  let addonBom = null
  const hasAddon = item.addon_template_id && addonTemplate && positive(item.addon_width_m) && positive(item.addon_height_m)
  if (hasAddon) {
    const addon = { width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m), panel_count: item.addon_panel_count || 1, quantity: 1, extra_lines: [] }
    const ao = buildEngineAddonOpening(item, project, addon, addonTemplate, ctx.typesById, ctx.infillTypesById)
    const aPrepared = prepareComponents({ template: addonTemplate, components: byT(ctx.componentsByTemplate, addonTemplate.id), joints: byT(ctx.jointsByTemplate, addonTemplate.id), index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
    issues.push(...aPrepared.issues)
    addonBom = computeBomForOpening(ao.opening, addonTemplate, aPrepared.components, byT(ctx.hardwareByTemplate, addonTemplate.id), pricing, ao.infillType)
  }

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
