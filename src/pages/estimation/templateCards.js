// src/pages/estimation/templateCards.js
// Pure helpers for the BOM-template picture cards (TemplateCardGrid): what each card draws, the type filter chips,
// search and the item form's pick. No React, no Supabase.
//
// Thumbnail (owner 2026-10-31, "pick by picture" like Toolkit), never with dimension lines or text:
//   - a part-editor template (layout_kind) with its model loaded: the part drawing (partSvgString bare) at the sample size;
//   - any other template: the frame preview (buildFramePreview, dims: []) at the sample size, as LayoutTemplatePicker does;
//   - nothing drawable (layout_kind model not loaded / refused, bad data): a placeholder with the template's first letters.
// Sample size: 1.5 × 1.2 m (itemForm.js SAMPLE) for everything, 0.9 × 2.1 m for a door — a template whose type or one of
// its parent types is named with "ประตู".
import { buildFramePreview } from '../../lib/framePreview.js'
import { partSvgString } from '../../lib/partPreviewSvg.js'
import { partPreviewModel } from '../../lib/itemPreviewSignature.js'
import { safeSvgDataUri } from '../../lib/attachmentPages.js'
import { typeAndAncestorIds, typeLabel } from '../../lib/typeTree.js'
import { typePath } from './itemForm.js'

export const THUMB_SAMPLE = { w: 1.5, h: 1.2 }
export const DOOR_SAMPLE = { w: 0.9, h: 2.1 }
export const NO_TYPE = '__none__'

const chainOf = (typesById, typeId) => (typeId ? typeAndAncestorIds(typesById, typeId).map(id => (typesById || {})[id]).filter(Boolean) : [])

export const isDoorType = (typesById, typeId) => chainOf(typesById, typeId).some(t => String(t.name || '').includes('ประตู'))

export const thumbSample = (template, typesById) => (isDoorType(typesById, template && template.type_id) ? DOOR_SAMPLE : THUMB_SAMPLE)

// The first two letters of the name (Thai or Latin), upper-cased; '?' for a nameless template.
export function templateInitials(name) {
  const letters = Array.from(String(name || '').replace(/[\s\-_.()[\]]+/g, ''))
  return letters.length ? letters.slice(0, 2).join('').toUpperCase() : '?'
}

/**
 * What one card draws.
 * @returns {{ kind: 'part', src: string } | { kind: 'frame', preview: object } | { kind: 'none', initials: string }}
 */
export function templateThumb({ template, typesById = null, partModelByTemplate = null }) {
  const none = { kind: 'none', initials: templateInitials(template && template.name) }
  if (!template) return none
  const s = thumbSample(template, typesById)
  try {
    if (template.layout_kind) {
      const model = partPreviewModel({}, template, null, { model: (partModelByTemplate || {})[template.id] || null })
      const svg = model ? partSvgString({ model, widthMm: s.w * 1000, heightMm: s.h * 1000, bare: true }) : null
      const src = svg ? safeSvgDataUri(svg) : null
      return src ? { kind: 'part', src } : none
    }
    const p = buildFramePreview({ template, width_m: s.w, height_m: s.h, panel_count: 1, main_axis: template.main_axis })
    return p && p.units && p.units.length ? { kind: 'frame', preview: { ...p, dims: [] } } : none
  } catch {
    return none
  }
}

// The top-level type of a template's type (the tree root), or null for a typeless one.
export function rootTypeId(typesById, typeId) {
  const ids = typeId ? typeAndAncestorIds(typesById, typeId) : []
  return ids.length ? ids[ids.length - 1] : null
}

// Filter chips: "ทั้งหมด" then every top-level type that has at least one of the templates (by name), each with its count;
// "ไม่ระบุประเภท" last when some template has no (known) type.
export function typeChips(templates, typesById) {
  const list = templates || []
  const counts = {}
  for (const t of list) {
    const r = rootTypeId(typesById, t.type_id)
    const key = r && (typesById || {})[r] ? r : NO_TYPE
    counts[key] = (counts[key] || 0) + 1
  }
  const roots = Object.keys(counts).filter(k => k !== NO_TYPE).map(id => typesById[id])
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'))
  return [
    { id: '', label: 'ทั้งหมด', count: list.length },
    ...roots.map(t => ({ id: t.id, label: t.name, count: counts[t.id] })),
    ...(counts[NO_TYPE] ? [{ id: NO_TYPE, label: 'ไม่ระบุประเภท', count: counts[NO_TYPE] }] : []),
  ]
}

// The small line under the card's name: the type chain ("ประตู › บานเลื่อน"), or '' when typeless.
export const templateMeta = (template, typesById) => (template && template.type_id ? typeLabel(typesById, template.type_id) : '')

/**
 * Templates shown for a chip + search text. rootId: '' = all, NO_TYPE = typeless, else a root type id. Search is
 * case-insensitive; every word of the query must appear in the name or the type chain.
 */
export function filterTemplates(templates, { query = '', rootId = '', typesById = null } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return (templates || []).filter(t => {
    if (rootId) {
      const r = rootTypeId(typesById, t.type_id)
      const key = r && (typesById || {})[r] ? r : NO_TYPE
      if (key !== rootId) return false
    }
    if (!words.length) return true
    const hay = `${t.name || ''} ${templateMeta(t, typesById)}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

/**
 * The item form's card list: the active templates under the chosen type path (all of them with no type chosen; the
 * deepest chosen level narrows it to that type and its sub-types), plus the item's current template when it is not
 * among them (inactive, typeless or of another type), so the selected card is always on screen.
 */
export function templatesUnderPath(templates, typesById, path, currentId) {
  const active = (templates || []).filter(t => t.active !== false)
  const at = (path || []).length ? path[path.length - 1] : null
  const list = at ? active.filter(t => t.type_id && typeAndAncestorIds(typesById, t.type_id).includes(at)) : active
  const cur = currentId ? (templates || []).find(t => t.id === currentId) : null
  return cur && !list.some(t => t.id === cur.id) ? [...list, cur] : list
}

// A card picked in the item form: the template and the type cascade path down to its type ([] for a typeless one).
export const pickTemplate = (typesById, template) => ({ template_id: template.id, path: typePath(typesById, template.type_id) })
