// src/lib/layoutTemplates.js
// Layout templates ("แม่แบบรูปแบบ"): a main type + optional add-on type, position and proportions. They store NO series,
// colour, price or profile: those come from whatever series the item uses. Pure.
export const ADDON_POSITIONS = ['top', 'bottom', 'left', 'right']

const offers = (seriesTypes, seriesId, typeId) => (seriesTypes || []).some(st => st.series_id === seriesId && st.type_id === typeId)

// Layout templates for the chosen main type, usable ones first. `reason` says why a card is greyed out.
export function availableLayoutTemplates(templates, { mainTypeId, seriesId, seriesTypes }) {
  const rows = (templates || [])
    .filter(t => t.active !== false && (!mainTypeId || t.main_type_id === mainTypeId))
    .map(t => {
      let reason = null
      if (seriesId && !offers(seriesTypes, seriesId, t.main_type_id)) reason = 'main_type_not_offered'
      else if (seriesId && t.addon_type_id && !offers(seriesTypes, seriesId, t.addon_type_id)) reason = 'addon_type_not_offered'
      return { template: t, usable: reason === null, reason }
    })
  return [...rows.filter(r => r.usable), ...rows.filter(r => !r.usable)]
}

const r2 = n => Math.round(n * 100) / 100

// Proportions -> metres for a given main size. Top/bottom add-ons are sized against the main width and
// offset along it; left/right add-ons are sized against the main height and offset along it.
export function applyLayoutTemplate(tpl, mainWidthM, mainHeightM) {
  if (!tpl || !(mainWidthM > 0) || !(mainHeightM > 0)) return null
  const out = { main_panel_count: tpl.main_panel_count || 1, addon_type_id: null, addon_position: null, addon_width_m: null, addon_height_m: null, addon_offset_m: 0, addon_panel_count: 1 }
  if (!tpl.addon_type_id || !ADDON_POSITIONS.includes(tpl.addon_position)) return out
  const horizontal = tpl.addon_position === 'top' || tpl.addon_position === 'bottom'
  const along = horizontal ? mainWidthM : mainHeightM
  const aw = horizontal ? mainWidthM * Number(tpl.addon_width_ratio) : mainWidthM * Number(tpl.addon_width_ratio)
  const ah = mainHeightM * Number(tpl.addon_height_ratio)
  return {
    ...out, addon_type_id: tpl.addon_type_id, addon_position: tpl.addon_position,
    addon_width_m: r2(aw), addon_height_m: r2(ah), addon_offset_m: r2(along * Number(tpl.addon_offset_ratio || 0)),
    addon_panel_count: tpl.addon_panel_count || 1,
  }
}

// The BOM templates that can build a given type (a layout stores types, the item stores a BOM template).
export const bomTemplatesForType = (bomTemplates, typeId) => (bomTemplates || []).filter(t => t.active !== false && t.type_id === typeId)

// The values to save when the owner ticks "save as layout template" in the item form.
// Ratios are taken against the item's own sizes; positions/offsets are clamped so the template re-applies cleanly.
export function layoutTemplateFromItem({ name, mainTypeId, addonTypeId, position, widthM, heightM, addonWidthM, addonHeightM, offsetM, mainPanels, addonPanels }) {
  const base = { name: String(name || '').trim(), main_type_id: mainTypeId, main_panel_count: mainPanels || 1, active: true }
  if (!base.name || !mainTypeId || !(widthM > 0) || !(heightM > 0)) return null
  if (!addonTypeId || !ADDON_POSITIONS.includes(position) || !(addonWidthM > 0) || !(addonHeightM > 0)) {
    return { ...base, addon_type_id: null, addon_position: null, addon_offset_ratio: 0, addon_width_ratio: 1, addon_height_ratio: 0.33, addon_panel_count: 1 }
  }
  const horizontal = position === 'top' || position === 'bottom'
  const along = horizontal ? widthM : heightM
  return {
    ...base, addon_type_id: addonTypeId, addon_position: position, addon_panel_count: addonPanels || 1,
    addon_width_ratio: Math.round((addonWidthM / widthM) * 1000) / 1000,
    addon_height_ratio: Math.round((addonHeightM / heightM) * 1000) / 1000,
    addon_offset_ratio: Math.min(1, Math.max(0, Math.round(((offsetM || 0) / along) * 1000) / 1000)),
  }
}
