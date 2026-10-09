// src/lib/estimationCatalogViews.js
// What the screens may offer for a series (and optionally a type). Pure; reads the index built by
// buildCatalogIndex (Task 2 adds types / seriesTypesBySeries / seriesPartsBySeries to it).

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

// Distinct thicknesses (mm, ascending) of the active profiles a series offers. One value = the screen locks it.
export function thicknessesForSeries(index, seriesId) {
  const seen = new Set()
  for (const l of index.seriesProfilesBySeries[seriesId] || []) {
    const p = index.profiles[l.profile_id]
    const t = p ? Number(p.thickness_mm) : NaN
    if (p && p.active !== false && Number.isFinite(t) && t > 0) seen.add(t)
  }
  return [...seen].sort((a, b) => a - b)
}

// Parts of one kind ('hardware' | 'hardware_set' | 'accessory') linked to the series. A link with
// type_id NULL means "every type"; with a typeId only NULL links and that type's links count; with no
// typeId every link of the series counts.
export function partsForSeries(index, seriesId, typeId, kind) {
  const out = new Map()
  for (const l of index.seriesPartsBySeries[seriesId] || []) {
    if (typeId && l.type_id && l.type_id !== typeId) continue
    const p = index.parts[l.part_id]
    if (p && p.active !== false && p.kind === kind) out.set(p.id, p)
  }
  return [...out.values()].sort(byName)
}
export const hardwareSetsForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'hardware_set')
export const hardwareForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'hardware')
export const accessoriesForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'accessory')

export function typesForSeries(index, seriesId) {
  return (index.seriesTypesBySeries[seriesId] || [])
    .map(st => index.types[st.type_id])
    .filter(t => t && t.active !== false)
    .sort(byName)
}

export function seriesForType(index, typeId) {
  const out = []
  for (const [seriesId, links] of Object.entries(index.seriesTypesBySeries)) {
    const s = index.series[seriesId]
    if (s && s.active !== false && links.some(l => l.type_id === typeId)) out.push(s)
  }
  return out.sort(byName)
}

// Whether frame and sash of this series+type may use different thicknesses (owner: only where the type allows it).
export function allowsMixedThickness(index, seriesId, typeId) {
  const link = (index.seriesTypesBySeries[seriesId] || []).find(l => l.type_id === typeId)
  return !!(link && link.allow_mixed_thickness === true)
}
