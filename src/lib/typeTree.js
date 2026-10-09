// src/lib/typeTree.js
// Parent / child door-window types, up to three levels (กลุ่มหลัก → แบบ → แบบย่อย). Pure.
// A type that has active children is a grouping only: templates, layout templates and items choose a leaf (Ruling 18).

const MAX_LEVELS = 3
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const asRows = types => (Array.isArray(types) ? types : Object.values(types || {})).filter(Boolean)

// { [parentId]: [child rows, sorted by name] }
function childrenByParent(types) {
  const out = {}
  for (const t of asRows(types)) if (t.parent_id) (out[t.parent_id] ||= []).push(t)
  for (const k of Object.keys(out)) out[k].sort(byName)
  return out
}

// [typeId, parentId?, grandparentId?] nearest first; stops at an unknown id or a loop. `typesById` is index.types.
export function typeAndAncestorIds(typesById, typeId) {
  const ids = []
  let cur = typeId
  while (cur && !ids.includes(cur) && ids.length < MAX_LEVELS) {
    ids.push(cur)
    const t = (typesById || {})[cur]
    cur = t ? t.parent_id : null
  }
  return ids
}

// [{ type, children: [...] }] sorted by name, at most three levels; a type whose parent is missing is shown as a root.
export function buildTypeTree(types) {
  const rows = asRows(types)
  const ids = new Set(rows.map(t => t.id))
  const kids = childrenByParent(rows)
  const node = (t, seen, level) => ({
    type: t,
    children: level >= MAX_LEVELS ? [] : (kids[t.id] || []).filter(c => !seen.has(c.id)).map(c => node(c, new Set([...seen, c.id]), level + 1)),
  })
  return rows.filter(t => !t.parent_id || !ids.has(t.parent_id)).sort(byName).map(t => node(t, new Set([t.id]), 1))
}

// Active types with no active child.
export function selectableTypes(types) {
  const rows = asRows(types)
  const parents = new Set(rows.filter(t => t.parent_id && t.active !== false).map(t => t.parent_id))
  return rows.filter(t => t.active !== false && !parents.has(t.id)).sort(byName)
}

export const isSelectableType = (types, typeId) => !!typeId && selectableTypes(types).some(t => t.id === typeId)

// "ประตู › บานเลื่อน › รางล่าง"; '' for an unknown id.
export function typeLabel(typesById, typeId) {
  const chain = typeAndAncestorIds(typesById, typeId).map(id => (typesById || {})[id]).filter(Boolean)
  return chain.reverse().map(t => t.name).join(' › ')
}

// Own rate if set (0 counts), else the nearest ancestor's, else null.
export function typeLabourDefault(typesById, typeId) {
  for (const id of typeAndAncestorIds(typesById, typeId)) {
    const t = (typesById || {})[id]
    const v = t ? t.default_labour_per_sqm : null
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

// A series linked to a type also offers every descendant. An explicit link wins; otherwise the NEAREST linked
// ancestor's flag is inherited. New array, inputs untouched.
export function expandSeriesTypes(seriesTypes, types) {
  const rows = asRows(types)
  const kids = childrenByParent(rows)
  const level = Object.fromEntries(rows.map(t => [t.id, typeAndAncestorIds(Object.fromEntries(rows.map(r => [r.id, r])), t.id).length]))
  const out = [...(seriesTypes || [])]
  const have = new Set(out.map(l => `${l.series_id}|${l.type_id}`))
  // deepest links first so a nearer ancestor claims its descendants before a farther one
  const ordered = [...(seriesTypes || [])].sort((a, b) => (level[b.type_id] || 0) - (level[a.type_id] || 0))
  for (const l of ordered) {
    const stack = [...(kids[l.type_id] || [])]
    const seen = new Set([l.type_id])
    while (stack.length) {
      const c = stack.pop()
      if (seen.has(c.id)) continue
      seen.add(c.id)
      stack.push(...(kids[c.id] || []))
      const key = `${l.series_id}|${c.id}`
      if (have.has(key)) continue
      have.add(key)
      out.push({ id: null, series_id: l.series_id, type_id: c.id, allow_mixed_thickness: l.allow_mixed_thickness === true, inherited_from: l.type_id })
    }
  }
  return out
}
