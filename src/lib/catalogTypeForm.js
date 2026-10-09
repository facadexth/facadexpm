// Pure helpers for the catalog "ประเภทบาน" tree screens and the profile form. No React, no database.
import { buildTypeTree, selectableTypes, typeLabel, typeAndAncestorIds } from './typeTree.js'

const asRows = types => (Array.isArray(types) ? types : Object.values(types || {})).filter(Boolean)
const byId = types => Object.fromEntries(asRows(types).map(t => [t.id, t]))

// Tree flattened for display: [{ type, level (1-3), hasChildren, selectable }] in tree order.
export function flattenTypeTree(types) {
  const leaves = new Set(selectableTypes(types).map(t => t.id))
  const out = []
  const walk = (nodes, level) => {
    for (const n of nodes) {
      out.push({ type: n.type, level, hasChildren: n.children.length > 0, selectable: leaves.has(n.type.id) })
      walk(n.children, level + 1)
    }
  }
  walk(buildTypeTree(types), 1)
  return out
}

// id of the type plus all its descendants.
export function typeSubtreeIds(types, typeId) {
  const rows = asRows(types)
  const ids = new Set([typeId])
  let grew = true
  while (grew) {
    grew = false
    for (const t of rows) if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) { ids.add(t.id); grew = true }
  }
  return ids
}

// How many levels the type and everything under it spans (1 = no children).
function subtreeHeight(types, typeId) {
  const rows = asRows(types)
  const h = id => 1 + Math.max(0, ...rows.filter(t => t.parent_id === id).map(t => h(t.id)))
  return typeId ? h(typeId) : 1
}

// Options for "อยู่ใต้ประเภท": level 1 or 2 types, never the edited type or inside its own subtree,
// and never one that would push the edited type's own children past three levels.
export function parentOptions(types, editingId = null) {
  const map = byId(types)
  const banned = editingId ? typeSubtreeIds(types, editingId) : new Set()
  const height = editingId ? subtreeHeight(types, editingId) : 1
  return asRows(types)
    .filter(t => !banned.has(t.id))
    .filter(t => typeAndAncestorIds(map, t.id).length <= 2 && typeAndAncestorIds(map, t.id).length + height <= 3)
    .map(t => ({ value: t.id, label: typeLabel(map, t.id) + (t.active === false ? ' (ปิดใช้งาน)' : '') }))
    .sort((a, b) => a.label.localeCompare(b.label, 'th'))
}

// A child always has its parent's category; null when there is no parent (the user picks).
export function categoryForParent(types, parentId) {
  if (!parentId) return null
  return byId(types)[parentId]?.category ?? null
}

// Type picker options in tree order, indented labels via the full path. Inactive ones are kept only when `keepIds` has them.
export function typePickerOptions(types, keepIds = new Set()) {
  const map = byId(types)
  return flattenTypeTree(types)
    .filter(r => r.type.active !== false || keepIds.has(r.type.id))
    .map(r => ({ id: r.type.id, value: r.type.id, hasChildren: r.hasChildren, label: typeLabel(map, r.type.id) + (r.type.active === false ? ' (ปิดใช้งาน)' : '') }))
}

// The database trigger raises English text; show it in Thai.
const TYPE_ERRORS = [
  [/at most three levels/i, 'ประเภทมีได้สูงสุด 3 ระดับ'],
  [/own parent/i, 'ประเภทอยู่ใต้ตัวเองไม่ได้'],
  [/under its own child/i, 'ย้ายประเภทไปไว้ใต้ประเภทย่อยของตัวเองไม่ได้'],
  [/same category as its parent/i, 'ประเภทย่อยต้องมีประเภทหลักเดียวกับประเภทแม่'],
  [/another category/i, 'เปลี่ยนประเภทหลักไม่ได้ เพราะมีประเภทย่อยที่เป็นประเภทหลักอื่นอยู่'],
  [/parent type not found/i, 'ไม่พบประเภทแม่'],
]
export function thaiTypeError(message) {
  const m = String(message || '')
  const hit = TYPE_ERRORS.find(([re]) => re.test(m))
  return hit ? hit[1] : null
}

// Sketch shape from the shape group text ("กล่องเรียบ" is an open channel).
export const sketchShapeFor = shapeGroup => (String(shapeGroup || '').includes('กล่องเรียบ') ? 'u' : 'box')

// Other profiles of the same extruder and shape group, thinnest first.
export function sameShapeProfiles(profiles, profile) {
  const g = String(profile?.shape_group || '').trim()
  if (!g) return []
  return asRows(profiles)
    .filter(p => p.id !== profile.id && p.provider_id === profile.provider_id && String(p.shape_group || '').trim() === g)
    .sort((a, b) => (Number(a.thickness_mm) || 0) - (Number(b.thickness_mm) || 0))
}
