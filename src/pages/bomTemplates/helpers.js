// src/pages/bomTemplates/helpers.js
// Pure helpers for the BOM template editor (kept out of the components so they can be tested).
import { buildTypeTree, selectableTypes, typeLabel } from '../../lib/typeTree.js'
import { jointDeductionMm } from '../../lib/assembly.js'
import { hardwareSetsForSeries, seriesForType, allowsMixedThickness } from '../../lib/estimationCatalogViews.js'

const byThai = (a, b) => String(a).localeCompare(String(b), 'th')
const blank = v => v === null || v === undefined || String(v).trim() === ''

// Distinct profile families of the catalog (the link's own family wins over the profile's, as in pricing).
export function catalogFamilies(index) {
  const out = new Set()
  if (!index) return []
  for (const links of Object.values(index.seriesProfilesBySeries || {})) {
    for (const l of links) {
      const p = index.profiles[l.profile_id]
      const f = String(l.family ?? (p && p.family) ?? '').trim()
      if (f) out.add(f)
    }
  }
  return [...out].sort(byThai)
}

// Options for the template's type select: every selectable type, plus the saved one when it no longer is.
export function templateTypeOptions(types, typesById, savedTypeId) {
  const opts = selectableTypes(types).map(t => ({ id: t.id, label: typeLabel(typesById, t.id) || t.name }))
  const savedMissing = !!savedTypeId && !opts.some(o => o.id === savedTypeId) && !!typesById[savedTypeId]
  if (savedMissing) opts.push({ id: savedTypeId, label: typeLabel(typesById, savedTypeId) || typesById[savedTypeId].name })
  return { options: opts, savedNotSelectable: savedMissing }
}

// Whether the thickness-role select is shown: some series offers the type with mixed thickness allowed.
export function typeAllowsMixed(index, typeId) {
  if (!index || !typeId) return false
  return seriesForType(index, typeId).some(s => allowsMixedThickness(index, s.id, typeId))
}

// Part options for a hardware line: active hardware / accessory / hardware_set parts, "P-0007 name".
export function hardwarePartOptions(parts) {
  return Object.values(parts || {})
    .filter(p => p && p.active !== false && ['hardware', 'accessory', 'hardware_set'].includes(p.kind))
    .map(p => ({ id: p.id, label: `${p.code ? p.code + ' ' : ''}${p.name}` }))
    .sort((a, b) => byThai(a.label, b.label))
}

// A joint was deleted: components pointing at it lose the link, those pointing past it shift down by one.
export function relinkAfterJointRemoved(rows, removedIndex) {
  return (rows || []).map(r => {
    if (r.joint_index === '' || r.joint_index === null || r.joint_index === undefined) return r
    const n = Number(r.joint_index)
    if (n === removedIndex) return { ...r, joint_index: '' }
    if (n > removedIndex) return { ...r, joint_index: String(n - 1) }
    return r
  })
}

// First reason the component rows cannot be saved (Thai), or null.
export function validateComponentRows(rows, joints) {
  for (const [i, r] of (rows || []).entries()) {
    const n = i + 1
    const ded = blank(r.length_deduction_mm) ? NaN : Number(r.length_deduction_mm)
    if (!Number.isFinite(ded) || ded < 0) return `ชิ้นส่วนที่ ${n}: กรอกระยะหัก (มม.) เป็นตัวเลข 0 ขึ้นไป`
    const q = blank(r.quantity_value) ? NaN : Number(r.quantity_value)
    if (!Number.isFinite(q) || q <= 0) return `ชิ้นส่วนที่ ${n}: จำนวนต้องมากกว่า 0`
    if (!blank(r.joint_index)) {
      const j = (joints || [])[Number(r.joint_index)]
      if (!j) return `ชิ้นส่วนที่ ${n}: จุดชนที่เลือกไม่มีอยู่`
      if (String(r.profile_family || '').trim() !== String(j.secondary_family || '').trim()) return `ชิ้นส่วนที่ ${n}: ส่วนประกอบที่ผูกจุดชนต้องเป็นหน้าตัดเดียวกับเส้นรองของจุดชน`
    }
  }
  return null
}

// The deduction a joint takes, read from the catalog profile(s) of its main family. Several profiles can share a
// family (different series), so every distinct result is listed. Returns [{ mm, profile }] (mm null = unknown).
export function jointDeductionPreview(index, joint, typeId) {
  if (!joint) return []
  if (joint.deduction_mode === 'manual' || joint.cut_style === 'miter45') {
    const d = jointDeductionMm({ ...joint, deduction_mm: joint.deduction_mm }, null)
    return [{ mm: d.mm, profile: d.source === 'miter' ? 'ตัด 45° ไม่หักเพิ่ม' : 'กำหนดเอง' }]
  }
  if (!index || !joint.main_family) return []
  const seriesIds = typeId ? seriesForType(index, typeId).map(s => s.id) : Object.keys(index.seriesProfilesBySeries || {})
  const seen = new Map()
  for (const sid of seriesIds) {
    for (const l of index.seriesProfilesBySeries[sid] || []) {
      const p = index.profiles[l.profile_id]
      if (!p || p.active === false || String(l.family ?? p.family ?? '').trim() !== joint.main_family) continue
      const mm = jointDeductionMm({ ...joint, deduction_mode: 'auto' }, p).mm
      const key = `${mm}`
      if (!seen.has(key)) seen.set(key, { mm, profile: p.name })
    }
  }
  return [...seen.values()]
}

// Depth (mm) of the main bar that the secondary butts against, for the sketch: the first matching catalog profile.
export function mainBarDepthMm(index, family) {
  if (!index || !family) return null
  for (const links of Object.values(index.seriesProfilesBySeries || {})) {
    for (const l of links) {
      const p = index.profiles[l.profile_id]
      if (p && String(l.family ?? p.family ?? '').trim() === family) {
        const d = Number(p.primary_contact === 'depth' ? p.width_mm : p.depth_mm)
        if (d > 0) return d
      }
    }
  }
  return null
}

// Geometry for the notch sketch (SVG user units), from numbers only. Port of the mockup's drawNotch.
export function notchGeometry({ style, widthMm, depthMm, mainDepthMm }) {
  const P = Number(mainDepthMm) > 0 ? Number(mainDepthMm) : 40
  const k = 2.4, x0 = 60, y0 = 20
  const w = Math.min(Math.max(Number(widthMm) || 0, 0), P)
  const d = Math.min(Math.max(Number(depthMm) || 0, 0), P)
  const main = { x: x0, y: y0, width: 140, height: P * k * 0.6 }
  const by = y0 + P * k * 0.6, bw = w * k * 0.9 + 20, bx = x0 + 70 - bw / 2, bh = 70
  let pts
  if (style === 'miter45') pts = [[bx, by], [bx + bw, by + bw * 0.6], [bx + bw, by + bh], [bx, by + bh]]
  else if (style === 'notch') {
    const nd = d * k * 0.6, nw = Math.min(bw / 2, w * k * 0.5)
    pts = [[bx, by + nd], [bx + bw / 2 - nw / 2, by + nd], [bx + bw / 2 - nw / 2, by], [bx + bw / 2 + nw / 2, by], [bx + bw / 2 + nw / 2, by + nd], [bx + bw, by + nd], [bx + bw, by + bh], [bx, by + bh]]
  } else pts = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]]
  return { main, mainDepth: P, points: pts.map(p => p.join(',')).join(' '), labelX: bx + bw / 2, labelY: by + bh - 8 }
}

// ---- project hardware packages tab ----

// Flat list of every type at any level: [{ id, label, depth }] in tree order.
export function flatTypeRows(types, typesById) {
  const out = []
  const walk = (nodes, depth) => nodes.forEach(n => { out.push({ id: n.type.id, label: typeLabel(typesById, n.type.id) || n.type.name, depth }); walk(n.children, depth + 1) })
  walk(buildTypeTree((types || []).filter(t => t.active !== false)), 0)
  return out
}

export const SET_UNASSIGNED = ''        // no row is saved
export const SET_NONE = '__none__'      // row with NULL set

// DB items of a package -> editor rows.
export function editorRowsFromItems(items, packageId) {
  return (items || []).filter(i => i.package_id === packageId).map(i => ({ type_id: i.type_id, choice: i.hardware_set_id || SET_NONE }))
}
// Editor rows -> raw rows for saveItems (unassigned rows and rows without a type are not saved).
export function itemRowsForSave(editorRows) {
  return (editorRows || []).filter(r => r.type_id && r.choice !== SET_UNASSIGNED)
    .map(r => ({ type_id: r.type_id, hardware_set_id: r.choice === SET_NONE ? null : r.choice }))
}

// Sets selectable for a type: parts linked to the package series for that type, or every active hardware set when the
// package has no series. The currently chosen set stays listed even if it no longer qualifies.
export function hardwareSetChoices(index, seriesId, typeId, currentChoice) {
  if (!index) return []
  const list = seriesId
    ? hardwareSetsForSeries(index, seriesId, typeId)
    : Object.values(index.parts || {}).filter(p => p && p.active !== false && p.kind === 'hardware_set').sort((a, b) => byThai(a.name, b.name))
  const out = list.map(p => ({ id: p.id, label: `${p.code ? p.code + ' ' : ''}${p.name}` }))
  if (currentChoice && currentChoice !== SET_NONE && !out.some(o => o.id === currentChoice) && index.parts[currentChoice]) {
    const p = index.parts[currentChoice]
    out.push({ id: p.id, label: `${p.code ? p.code + ' ' : ''}${p.name} (ไม่ตรงกับซีรีส์)` })
  }
  return out
}

// Inserted joint rows ({ id, sort_order }) in any order -> ids by position (index i = the row saved with sort_order i).
export function orderJointIds(inserted, count) {
  const out = new Array(count).fill(null)
  for (const r of inserted || []) {
    const k = Number(r.sort_order)
    if (!Number.isInteger(k) || k < 0 || k >= count || out[k] !== null) throw new Error('บันทึกจุดชนไม่ครบ')
    out[k] = r.id
  }
  if ((inserted || []).length !== count || out.some(x => x === null)) throw new Error('บันทึกจุดชนไม่ครบ')
  return out
}


// The editor's message when a template's part model cannot be opened for a reason a reload does not fix (Ruling R-F5):
// layout_mismatch = the template was made with another แบบชิ้นส่วน than its type now says (the type's kind was changed);
// unknown_layout = a kind this version does not know. null for any other error (the caller keeps the "reload" wording).
// labels: kind -> Thai label (layoutRegistry.layoutLabels).
export function layoutLoadText(error, templateKind, typeKind, labels = {}) {
  const lab = k => (k && labels[k]) || k || '—'
  if (error === 'layout_mismatch') return `แบบชิ้นส่วนของเทมเพลตนี้ (${lab(templateKind)}) ไม่ตรงกับประเภท (${lab(typeKind)}) — แก้แบบชิ้นส่วนที่ประเภทในแคตตาล็อก หรือสร้างเทมเพลตใหม่`
  if (error === 'unknown_layout') return `ไม่รู้จักแบบชิ้นส่วนของเทมเพลตนี้ (${templateKind || '—'}) — โปรแกรมรุ่นนี้ยังเปิดเทมเพลตนี้ไม่ได้ กรุณาแจ้งผู้ดูแลระบบ`
  return null
}
