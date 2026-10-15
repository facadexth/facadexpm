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
import { expandAddons } from './addonExpand.js'
import { layoutAddons } from './addonModel.js'
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
// template's params for inputs marked `estimator` that the type does not pin (model.fixedKeys, R-F2: swing / hanging
// door `leaves` and casement `n` are the item's unless the type sets them; anything else is the template's). Returns the same model object when nothing changes, a
// new one (setParams: piece counts and factors follow) otherwise, { error: 'layout_params_invalid' } when the layout
// refuses the combination, and the input unchanged for a missing / refused model.
export function modelForItem(model, item) {
  if (!model || model.error || !model.layout_kind) return model
  const lp = coerceParams(model.layout_kind, item && item.layout_params)
  const patch = {}
  const fixed = model.fixedKeys || []
  for (const inp of inputsOf(model.layout_kind)) {
    if (!inp.estimator || fixed.includes(inp.key) || !(inp.key in lp)) continue
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
// addon (optional, main template only): { addons, pieceRows, main: { widthMm, heightMm } } — the item's inline add-ons
// (addonExpand.js). Their merge overrides / sideButt go into expandParts, their merge pieces are appended after the
// main rows; `expansion` (attach units, merge glass / notes, add-on issues) comes back for costOpening.
function preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm, addon = null }) {
  // a model refused at load (partSave: layout_mismatch / layout_params_invalid) or by the item's params
  if (model && model.error) return { components: [], issues: [{ role_name: template.name || '', reason: model.error }], expansion: null }
  const opts = partFamilyOpts({ model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm })
  const buttOf = buttOfFor(opts)
  const expansion = addon ? expandItemAddons(addon, buttOf, template.layout_kind) : null
  const { components, issues } = expandParts({ model, buttOf, widthOf: widthOfFor(opts), overrides: expansion ? expansion.merge.overrides : undefined, sideButt: expansion ? expansion.merge.sideButt : undefined })
  const thick = { allowMixed, sashThicknessMm }
  const merged = expansion ? expansion.merge.components.map((c, i) => ({ ...c, sort_order: components.length + i })) : []
  return {
    components: applyRoleThickness([...components, ...merged], thick),
    issues: issues.map(i => (i.reason === 'no_model' && !i.role_name ? { ...i, role_name: template.name || '' } : i)),
    expansion,
    attach: expansion ? expansion.attach.map(u => ({ ...u, components: applyRoleThickness(u.components, thick) })) : [],
  }
}

// expandAddons with an override lengthMm that is not a finite number dropped (the key, not the whole override).
function expandItemAddons({ addons, pieceRows, main }, buttOf, layoutKind) {
  const exp = expandAddons({ addons, pieceRows: pieceRows || [], main, buttOf, layoutKind })
  const overrides = {}
  for (const [pos, ov] of Object.entries(exp.merge.overrides || {})) {
    const o = { ...ov }
    if ('lengthMm' in o && !(o.lengthMm != null && Number.isFinite(Number(o.lengthMm)))) delete o.lengthMm
    overrides[pos] = o
  }
  return { ...exp, merge: { ...exp.merge, overrides } }
}

// item: the item whose layout_params apply (main template only; null for the add-on).
function prepareComponents({ template, components, joints, partModelByTemplate, index, seriesId, thicknessMm, sashThicknessMm, item = null, addon = null }) {
  const allowMixed = template.type_id ? allowsMixedThickness(index, seriesId, template.type_id) : false
  if (template.layout_kind) {
    const model = modelForItem((partModelByTemplate && partModelByTemplate[template.id]) || null, item)
    return preparePartComponents({ template, model, index, seriesId, thicknessMm, allowMixed, sashThicknessMm, addon })
  }
  return applyJoints({ components: applyRoleThickness(components, { allowMixed, sashThicknessMm }), joints, index, seriesId, thicknessMm })
}

const ADDON_NAME = 'ช่องแสง'
const ADDON_ITEM_REASONS = new Set(['addon_not_loaded', 'addon_conflict', 'addon_needs_layout'])

// Every BOM of a costOpening result: main, legacy add-on, then each attach unit (inline add-ons). Consumers that roll up
// lines (project BOM, price structure, stale prices, extruder compare) read this, so an attach unit is never left out.
// Merge pieces are already main BOM lines; merge glass is r.addonMerge.glass (not in any BOM).
export function costBoms(r) {
  if (!r) return []
  return [r.bom, r.addonBom, ...(r.addonBoms || []).map(a => a && a.bom)].filter(Boolean)
}

// A costOpening().unresolved entry that is an inline add-on problem never shown as an unresolved profile line
// (expander issues carry addonIndex; item-level ones are addon_not_loaded / addon_conflict / addon_needs_layout).
export function isAddonIssue(u) {
  return !!u && u.source === 'addon' && (u.addonIndex !== undefined || ADDON_ITEM_REASONS.has(u.reason))
}

// Which inline add-ons (estimation_item_addons, mm) of `item` are costed, and the item-level add-on issues:
// a load error (ctx.addonPiecesError / itemAddonsError) on a layout_kind template ⇒ addon_not_loaded, nothing costed;
// a legacy add-on (item.addon_template_id) as well ⇒ addon_conflict, legacy path only; a template without layout_kind
// ⇒ addon_needs_layout. Maps still loading (absent) are not an error: no add-ons, no issue.
export function addonPlan(ctx, template, item) {
  const c = ctx || {}
  const t = template || {}
  const it = item || {}
  const issue = reason => ({ addons: [], issues: [{ name: ADDON_NAME, reason, source: 'addon' }] })
  // an item without an id (QuickQuote throw-away, a new item in the form) has no saved add-ons: nothing failed to load
  if (it.id == null) return { addons: [], issues: [] }
  if (t.layout_kind && (c.addonPiecesError || c.itemAddonsError)) return issue('addon_not_loaded')
  const raw = it.id != null && c.itemAddonsByOpening ? c.itemAddonsByOpening[it.id] : null
  const addons = Array.isArray(raw) ? raw : []
  if (!addons.length) return { addons: [], issues: [] }
  if (it.addon_template_id) return issue('addon_conflict')
  if (!t.layout_kind) return issue('addon_needs_layout')
  return { addons, issues: [] }
}

// The item preview's part context of a layout_kind template: { model, buttOf, widthOf, addons, overrides, sideButt }
// exactly as costOpening expands it (same model, same per-family thickness, the item's costed add-ons and their merge
// overrides / sideButt; [] / {} without add-ons), or null for a template without layout_kind or without a usable model.
// ctx = the costOpening context (index, partModelByTemplate, addonPiecesByTemplate, itemAddonsByOpening);
// resolved = resolveItemInputs(...) of the item; item (optional) = the item, whose layout_params adjust the model as in
// costing (modelForItem).
export function partPreviewCtx(ctx, template, resolved, item = null) {
  if (!template || !template.layout_kind) return null
  const model = modelForItem((ctx && ctx.partModelByTemplate && ctx.partModelByTemplate[template.id]) || null, item)
  if (!model || model.error) return null
  const index = ctx.index
  const r = resolved || {}
  const allowMixed = template.type_id && index ? allowsMixedThickness(index, r.series_id, template.type_id) : false
  const opts = partFamilyOpts({ model, index, seriesId: r.series_id, thicknessMm: r.thickness_mm, allowMixed, sashThicknessMm: r.sash_thickness_mm })
  const buttOf = buttOfFor(opts)
  const { addons } = addonPlan(ctx, template, item)
  const exp = addons.length
    ? expandItemAddons({ addons, pieceRows: (ctx.addonPiecesByTemplate || {})[template.id], main: mainMm(item) }, buttOf, template.layout_kind)
    : null
  return { model, buttOf, widthOf: widthOfFor(opts), addons, overrides: exp ? exp.merge.overrides : {}, sideButt: exp ? exp.merge.sideButt : {} }
}

// The main unit's frame in metres: the item's width × height, or the envelope of its costed merge add-ons.
function mainFrameUnit(item, addons) {
  const merge = (addons || []).filter(a => a && a.mode === 'merge' && ['top', 'bottom', 'left', 'right'].includes(a.position))
  if (!merge.length) return { width_m: Number(item.width_m), height_m: Number(item.height_m) }
  const { widthMm, heightMm } = mainMm(item)
  const env = layoutAddons({ widthMm, heightMm, addons: merge }).envelope
  return { width_m: env.w / 1000, height_m: env.h / 1000 }
}

const mainMm = item => ({ widthMm: (Number(item && item.width_m) || 0) * 1000, heightMm: (Number(item && item.height_m) || 0) * 1000 })

// ctx: { item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate,
//        typesById, infillTypesById, index, settings, asOf, packageItems?, partModelByTemplate?,
//        addonPiecesByTemplate?, itemAddonsByOpening?, addonPiecesError?, itemAddonsError? }
// partModelByTemplate: { [templateId]: model | { error } } (partSave.partModelsByTemplate) for templates with layout_kind;
// ignored otherwise. An { error } entry is reported by its reason (layout_mismatch ...), never priced.
// item.layout_params (estimation_openings) adjust the main template's model (modelForItem).
// Inline add-ons (ช่องแสง): itemAddonsByOpening[item.id] (mm, addonSave.loadItemAddons) on a layout_kind template, with
// the template's piece rows addonPiecesByTemplate[template.id] (addonSave.loadAddonPieces). See addonPlan for when they
// are costed. attach add-ons → addonBoms [{ addonIndex, bom }] (each its own opening at the item's infill, no hardware);
// merge add-ons → frame overrides / sideButt in the main expansion, their pieces in the main BOM, their glass in
// addonMerge.glass { area_sqm, cost, panes } (item infill price per sqm; 0 without infill, as the main unit).
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

  const plan = addonPlan(ctx, template, rawItem)
  const addonIssues = [...plan.issues]
  const addonInput = plan.addons.length ? { addons: plan.addons, pieceRows: byT(ctx.addonPiecesByTemplate, template.id), main: mainMm(item) } : null

  const main = buildEngineOpening(item, project, template, ctx.typesById, ctx.infillTypesById, ctx.packageItems)
  const prepared = prepareComponents({ template, components: byT(ctx.componentsByTemplate, template.id), joints: byT(ctx.jointsByTemplate, template.id), partModelByTemplate: ctx.partModelByTemplate, index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm, item: rawItem, addon: addonInput })
  issues.push(...prepared.issues)
  const bom = computeBomForOpening(main.opening, template, prepared.components, byT(ctx.hardwareByTemplate, template.id), pricing, main.infillType)

  // inline add-ons: attach units are their own openings; merge glass is priced at the item's infill
  const expansion = prepared.expansion || null
  const addonBoms = []
  let addonMerge = null
  if (expansion) {
    addonIssues.push(...expansion.issues.map(i => ({ name: i.role_name, reason: i.reason, source: 'addon', addonIndex: i.addonIndex })))
    // an attach unit is priced from its own expander bars only: the main template's grid (rail / mullion families, row
    // weights) would add grid lines on top of the unit's mullion / rail pieces (resolveGrid / computeBomForOpening)
    const unitTemplate = { ...template, grid_vertical_mullion_family: null, grid_horizontal_rail_family: null, grid_row_weights: [1] }
    for (const u of prepared.attach) {
      const opening = { ...main.opening, width_m: u.opening.width_m, height_m: u.opening.height_m, panel_count: u.opening.panel_count, hardware_set_id: null, extra_lines: [] }
      addonBoms.push({ addonIndex: u.addonIndex, bom: computeBomForOpening(opening, unitTemplate, u.components, [], pricing, main.infillType) })
    }
    const attachIdx = new Set(prepared.attach.map(u => u.addonIndex))
    const mg = expansion.glass.filter(g => !attachIdx.has(g.addonIndex))
    const area_sqm = mg.reduce((s, g) => s + (Number(g.count) || 0) * (Number(g.widthMm) || 0) * (Number(g.heightMm) || 0) / 1e6, 0)
    const pricePerSqm = main.infillType ? Number(main.infillType.price_per_sqm) || 0 : 0
    addonMerge = {
      components: prepared.components.filter(c => c.addon_index != null),
      notes: expansion.merge.notes,
      glass: { area_sqm, cost: area_sqm * pricePerSqm, panes: mg.reduce((s, g) => s + (Number(g.count) || 0), 0) },
    }
  }

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

  // frames for openingExtras (fixing points, sealant): a merge add-on grows the main frame to the merge envelope;
  // each attach unit is its own frame, like the legacy add-on
  const units = [mainFrameUnit(item, expansion ? plan.addons : [])]
  if (hasAddon) units.push({ width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m) })
  for (const u of (expansion ? prepared.attach : [])) units.push({ width_m: u.opening.width_m, height_m: u.opening.height_m })
  const extras = openingExtras({ units, settings, partsById: index.parts, pricing })
  const combined = combineOpeningBoms(bom, addonBom)
  combined.addonBoms = addonBoms
  combined.addonMerge = addonMerge
  combined.totalCost += addonBoms.reduce((s, a) => s + a.bom.totalCost, 0) + (addonMerge ? addonMerge.glass.cost : 0)
  return {
    resolved, bom, addonBom, addonBoms, addonMerge, extras, issues,
    total: combined.totalCost + extras.cost,
    unresolved: [
      ...own,
      ...bom.unresolvedDetails.map(d => ({ ...d, source: 'main' })),
      ...(addonBom ? addonBom.unresolvedDetails.map(d => ({ ...d, source: 'addon' })) : []),
      ...addonBoms.flatMap(a => a.bom.unresolvedDetails.map(d => ({ ...d, source: 'addon' }))),
      ...addonIssues,
      ...extras.unresolved.map(d => ({ ...d, source: 'extras' })),
      ...issues.map(i => ({ name: i.role_name, reason: i.reason, source: 'joint' })),
    ],
  }
}
