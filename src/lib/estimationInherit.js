// src/lib/estimationInherit.js
// Inheritance by NULL (spec Decision 1) and the availability checks (Decisions 2 and 5). Pure.
// A project default is used when the item leaves the field NULL. Infill and hardware set also have an
// explicit "none" flag on the item, because NULL already means "inherit".

const isSet = v => v !== null && v !== undefined && v !== ''
const first = (...vals) => { for (const v of vals) if (isSet(v)) return v; return null }
// Numeric columns can arrive as strings from the DB; the engine only accepts finite numbers, and 0 is a real value.
const firstNum = (...vals) => { for (const v of vals) { if (!isSet(v)) continue; const n = Number(v); if (Number.isFinite(n)) return n } return null }

export function resolveItemInputs(item, project, template, typesById) {
  const it = item || {}
  const pj = project || {}
  const type = template && template.type_id ? (typesById || {})[template.type_id] : null
  const typeLabour = type && Number(type.default_labour_per_sqm) > 0 ? Number(type.default_labour_per_sqm) : null
  return {
    series_id: first(it.series_id, pj.default_series_id),
    finish_id: first(it.alu_finish_id, pj.default_finish_id),
    infill_type_id: it.no_infill ? null : first(it.infill_type_id, pj.default_infill_id),
    hardware_set_id: it.no_hardware_set ? null : first(it.hardware_set_id, pj.default_hardware_set_id),
    thickness_mm: firstNum(it.thickness_mm, pj.default_thickness_mm),
    labour_per_sqm: firstNum(it.labour_per_sqm, pj.labour_per_sqm, typeLabour),
    profit_pct: firstNum(it.profit_pct, pj.profit_pct),
  }
}

// 'unknown' = cannot judge (no type on the template, no template, or no series yet); never a hard block.
export function typeAvailability(template, seriesId, seriesTypes) {
  if (!template || !template.type_id || !seriesId) return 'unknown'
  const offered = (seriesTypes || []).some(st => st.series_id === seriesId && st.type_id === template.type_id)
  return offered ? 'ok' : 'not_offered'
}

export function addonTemplatesForSeries(templates, seriesId, seriesTypes) {
  return (templates || []).filter(t => t.active !== false && typeAvailability(t, seriesId, seriesTypes) !== 'not_offered')
}

// Items that will inherit newSeriesId (their own series_id is null) but whose template or add-on
// that series does not offer. Used to list what a default-series change affects.
export function itemsAffectedByDefaultSeries(items, templatesById, newSeriesId, seriesTypes) {
  if (!newSeriesId) return []
  return (items || []).filter(item => {
    if (item.series_id) return false
    const main = typeAvailability((templatesById || {})[item.template_id], newSeriesId, seriesTypes)
    const addon = item.addon_template_id ? typeAvailability((templatesById || {})[item.addon_template_id], newSeriesId, seriesTypes) : 'unknown'
    return main === 'not_offered' || addon === 'not_offered'
  })
}
