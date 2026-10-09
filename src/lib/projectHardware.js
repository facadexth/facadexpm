// src/lib/projectHardware.js
// Project hardware packages: a hardware set per door/window type, chosen once per project (Ruling 20). Pure.
import { typeAndAncestorIds } from './typeTree.js'

// packageItems: rows of the project's chosen package, or null/undefined when the project has none.
// legacyDefaultId: estimation_projects.default_hardware_set_id (used only while there is no package).
export function hardwareSetStatus(packageItems, typesById, typeId, legacyDefaultId) {
  if (!Array.isArray(packageItems)) return { set_id: legacyDefaultId || null, status: 'legacy' }
  for (const id of typeAndAncestorIds(typesById, typeId)) {
    const r = packageItems.find(x => x.type_id === id)
    if (r) return r.hardware_set_id ? { set_id: r.hardware_set_id, status: 'set' } : { set_id: null, status: 'none' }
  }
  return { set_id: null, status: 'missing' }
}

// Distinct type ids (first-seen order) the chosen package does not cover; none for a project without a package.
export function missingHardwareTypeIds(packageItems, typesById, typeIds) {
  const out = []
  for (const id of typeIds || []) {
    if (id && !out.includes(id) && hardwareSetStatus(packageItems, typesById, id, null).status === 'missing') out.push(id)
  }
  return out
}

// Active packages the project's series may use (a package with no series fits any), sorted by name.
export function packagesForSeries(packages, seriesId) {
  return (packages || [])
    .filter(p => p.active !== false && (!p.series_id || p.series_id === seriesId))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th'))
}
