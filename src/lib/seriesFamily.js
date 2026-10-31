// src/lib/seriesFamily.js
// Series family (ซีรีส์หลัก, spec 2026-10-31 section 5): a group of one extruder's series (ICONIQ EURO = its fixed,
// casement and sliding series). The project default names a family; each item gets the family's series that makes its
// door/window type. A series with no family is a family of its own, keyed 'series:<id>'. Pure; reads the
// buildCatalogIndex index (index.series, index.seriesFamilies, index.providers) and the EXPANDED series-type links.
import { thicknessesForSeries } from './estimationCatalogViews.js'

const SOLO = 'series:'
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const familiesOf = index => (index && index.seriesFamilies) || {}

export const isSoloKey = key => typeof key === 'string' && key.startsWith(SOLO)
export const soloKey = seriesId => SOLO + seriesId
export const soloSeriesId = key => (isSoloKey(key) ? key.slice(SOLO.length) : null)

// The pickers' key of a series: its family while that family row exists and is active, else the series itself.
// Without familiesById the column is trusted as it is.
export function familyKey(series, familiesById) {
  const f = series && series.series_family_id
  if (f && (!familiesById || (familiesById[f] && familiesById[f].active !== false))) return f
  return soloKey(series.id)
}

// '' | family id | 'series:<id>': what the project defaults point at.
export function projectFamilyKey(project) {
  const pj = project || {}
  if (pj.default_series_family_id) return pj.default_series_family_id
  if (pj.default_series_id) return soloKey(pj.default_series_id)
  return ''
}

export function keyProviderId(index, key) {
  if (!key) return null
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? s.provider_id : null
  }
  const f = familiesOf(index)[key]
  return f ? f.provider_id : null
}

export function familyLabel(index, key) {
  if (!key) return ''
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? s.name : ''
  }
  const f = familiesOf(index)[key]
  return f ? f.name : ''
}

// Active series of a family, by name (providerId optional). A solo key gives its own series even when inactive, so an
// old project keeps pricing exactly as before.
export function familySeries(index, providerId, key) {
  if (!key) return []
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? [s] : []
  }
  return Object.values(index.series)
    .filter(s => s.series_family_id === key && s.active !== false && (!providerId || s.provider_id === providerId))
    .sort(byName)
}

// The family's series for one door/window type: the first by name with a link on typeId (seriesTypes = the expanded
// links, so a link on a parent type covers its children; a series linked to typeId itself beats one that only covers it
// through a parent), null when none has one. A solo key returns its series for
// any type (the old single-series default); no typeId (a template without a type) = the first series by name.
export function familySeriesForType(index, seriesTypes, providerId, key, typeId) {
  const list = familySeries(index, providerId, key)
  if (!list.length) return null
  if (isSoloKey(key) || !typeId) return list[0].id
  const links = (seriesTypes || []).filter(st => st.type_id === typeId)
  const hit = list.find(s => links.some(st => st.series_id === s.id && !st.inherited_from))
    || list.find(s => links.some(st => st.series_id === s.id))
  return hit ? hit.id : null
}

// Options of one extruder, or of every extruder (then labelled with it) when providerId is empty:
// [{ value: key, label, count }]: a family "ICONIQ EURO · 3 ชุด", a series without an (active) family by its name.
export function familyChoices(index, providerId) {
  const fams = familiesOf(index)
  const groups = new Map()
  for (const s of Object.values(index.series)) {
    if (s.active === false || (providerId && s.provider_id !== providerId)) continue
    const key = familyKey(s, fams)
    if (!groups.has(key)) groups.set(key, { key, providerId: s.provider_id, count: 0 })
    groups.get(key).count += 1
  }
  return [...groups.values()].map(g => {
    const base = isSoloKey(g.key) ? familyLabel(index, g.key) : `${fams[g.key].name} · ${g.count} ชุด`
    const prov = index.providers && index.providers[g.providerId]
    return { value: g.key, label: !providerId && prov ? `${base} · ${prov.name}` : base, count: g.count }
  }).sort((a, b) => String(a.label).localeCompare(String(b.label), 'th'))
}

// Frame thicknesses the project default offers: the family's own list when set (STANDARD = 1.0–2.0), else every
// thickness of its series. Ascending, distinct.
export function familyThicknesses(index, key) {
  if (!key) return []
  if (isSoloKey(key)) return thicknessesForSeries(index, soloSeriesId(key))
  const f = familiesOf(index)[key]
  if (f && Array.isArray(f.thickness_options) && f.thickness_options.length) {
    return [...new Set(f.thickness_options.map(Number))].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  }
  const seen = new Set()
  for (const s of familySeries(index, null, key)) for (const t of thicknessesForSeries(index, s.id)) seen.add(t)
  return [...seen].sort((a, b) => a - b)
}

// True when any series of the family has a type that allows frame and sash to differ.
export function familyAllowsMixed(index, seriesTypes, key) {
  const ids = familySeries(index, null, key).map(s => s.id)
  return (seriesTypes || []).some(l => ids.includes(l.series_id) && l.allow_mixed_thickness === true)
}

// The series the project defaults cover (package and banner checks): the family's series, or the single series.
export function projectSeriesIds(project) {
  const pj = project || {}
  if (Array.isArray(pj.familySeriesIds)) return pj.familySeriesIds
  return pj.default_series_id ? [pj.default_series_id] : []
}

// The project as every screen uses it. With a family: a copy with seriesForType(typeId) -> series id | null
// (memoised per type), familyName and familySeriesIds. Without one: the SAME object, so memo deps and snapshots stay.
// The family's own extruder is used, whatever primary_provider_id says.
export function withFamilyResolver(project, index, seriesTypes) {
  if (!project || !project.default_series_family_id || !index) return project
  const key = project.default_series_family_id
  const fam = familiesOf(index)[key] || null
  const providerId = fam ? fam.provider_id : null
  const memo = new Map()
  return {
    ...project,
    familyName: fam ? fam.name : '',
    familySeriesIds: familySeries(index, providerId, key).map(s => s.id),
    seriesForType(typeId) {
      const k = typeId || ''
      if (!memo.has(k)) memo.set(k, familySeriesForType(index, seriesTypes, providerId, key, typeId || null))
      return memo.get(k)
    },
  }
}

const THICKNESS_ERROR = 'ความหนาต้องเป็นตัวเลขมากกว่า 0 คั่นด้วยจุลภาค เช่น 1.0, 1.2, 1.5'

// The family form's thickness text ("1.0, 1.2 1.5") or a stored array -> sorted distinct numbers; blank -> null.
export function parseThicknessOptions(v) {
  const parts = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/).filter(Boolean)
  if (!parts.length) return { value: null, error: null }
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return { value: null, error: THICKNESS_ERROR }
  return { value: [...new Set(nums)].sort((a, b) => a - b), error: null }
}

export function formatThicknessOptions(arr) {
  if (!Array.isArray(arr) || !arr.length) return ''
  return arr.map(Number).map(n => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(', ')
}
