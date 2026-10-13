// Pure helpers for the catalog "ประเภทบาน" tree screens and the profile form. No React, no database.
import { buildTypeTree, selectableTypes, typeLabel, typeAndAncestorIds } from './typeTree.js'
import { LAYOUTS, kinds, layoutLabels, inputsOf, coerceParams } from './layoutRegistry.js'

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
// Ruling 25: type names stay unique per tenant (the Excel import refers to types by name), at every level.
export const TYPE_DUPLICATE_TEXT = 'ชื่อประเภทนี้มีอยู่แล้ว (ชื่อต้องไม่ซ้ำกันทุกระดับ) ให้ใช้ชื่อเต็ม เช่น ประตูบานเลื่อนรางล่าง'
const TYPE_ERRORS = [
  [/at most three levels/i, 'ประเภทมีได้สูงสุด 3 ระดับ'],
  [/own parent/i, 'ประเภทอยู่ใต้ตัวเองไม่ได้'],
  [/under its own child/i, 'ย้ายประเภทไปไว้ใต้ประเภทย่อยของตัวเองไม่ได้'],
  [/same category as its parent/i, 'ประเภทย่อยต้องมีประเภทหลักเดียวกับประเภทแม่'],
  [/another category/i, 'เปลี่ยนประเภทหลักไม่ได้ เพราะมีประเภทย่อยที่เป็นประเภทหลักอื่นอยู่'],
  [/parent type not found/i, 'ไม่พบประเภทแม่'],
  [/duplicate key|unique constraint/i, TYPE_DUPLICATE_TEXT],
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

// ---- layout kind of a type (door_window_types.layout_kind / layout_params, migration 2026-10-17-01) ----

// The type form's layout_kind select: every registered kind with its Thai label.
export const layoutKindOptions = () => kinds().filter(k => layoutLabels[k]).map(k => ({ value: k, label: layoutLabels[k] }))

const knownKind = kind => !!kind && Object.prototype.hasOwnProperty.call(LAYOUTS, kind)

// The inputs a type fixes for its templates and items (fixed_by_type): awning rows/cols, swing / frameless / hanging
// leaves, swing pivot, sliding door, curtain-wall unitized. [] for no kind, an unknown kind or a kind without any.
export const typeLayoutInputs = kind => (knownKind(kind) ? inputsOf(kind).filter(i => i.fixed_by_type) : [])

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const blankValue = v => v === '' || v === null || v === undefined

// The form's layout_params (text from number inputs, booleans from checkboxes) -> the JSON to save: the kind's
// fixed_by_type keys only, numbers as numbers (clamped), booleans as booleans, blanks left out; null when nothing is left.
export function typeLayoutParamsPayload(kind, values) {
  const inputs = typeLayoutInputs(kind)
  if (!inputs.length || !isPlainObject(values)) return null
  const src = {}
  for (const i of inputs) if (!blankValue(values[i.key])) src[i.key] = values[i.key]
  const out = coerceParams(kind, src)
  return Object.keys(out).length ? out : null
}

// The kind changed: keep only the values the new kind fixes by type.
export function typeLayoutParamsForKind(kind, values) {
  const out = {}
  if (!isPlainObject(values)) return out
  for (const i of typeLayoutInputs(kind)) if (Object.prototype.hasOwnProperty.call(values, i.key)) out[i.key] = values[i.key]
  return out
}

// CatalogCrud fields for the two columns. Both omitWhenAbsent: a type form with no kind sends neither key, so saving
// keeps working before the migration; a row that has the columns sends layout_kind null / layout_params {} when cleared
// (layout_params is NOT NULL). The view adds `render` to the layout_params field (TypesTab).
export function typeLayoutFields() {
  return [
    { key: 'layout_kind', label: 'แบบชิ้นส่วน', type: 'select', emptyLabel: '— ไม่กำหนด —', options: layoutKindOptions(), omitWhenAbsent: true,
      sets: (value, form) => ({ layout_params: typeLayoutParamsForKind(value, form.layout_params) }),
      hint: 'เทมเพลตของประเภทนี้จะใช้แบบชิ้นส่วนนี้' },
    { key: 'layout_params', label: 'ค่าที่ประเภทกำหนด', type: 'layout_params', default: {}, omitWhenAbsent: true, blankAs: {},
      serialize: (value, form) => typeLayoutParamsPayload(form.layout_kind, value),
      hidden: form => !typeLayoutInputs(form.layout_kind).length,
      hint: 'ค่าเหล่านี้ใช้กับทุกเทมเพลตและทุกรายการของประเภทนี้ (เว้นว่าง = ค่าเริ่มต้นของแบบ)' },
  ]
}
