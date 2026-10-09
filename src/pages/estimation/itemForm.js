// src/pages/estimation/itemForm.js
// Pure helpers for the item popup (mockup screen 2): type cascade, dependent-field reconciliation, the live item
// the cost and drawing are computed from, the project hardware set shown while inheriting, part labels for the
// "parts" drawing, layout-template cards and the quotation description context. No React, no Supabase.
import { buildTypeTree, typeAndAncestorIds, typeLabel, selectableTypes } from '../../lib/typeTree.js'
import { thicknessesForSeries, hardwareSetsForSeries, allowsMixedThickness } from '../../lib/estimationCatalogViews.js'
import { buildOpeningPayload, validateForm } from '../../lib/openingPayload.js'
import { hardwareSetStatus } from '../../lib/projectHardware.js'
import { availableLayoutTemplates, applyLayoutTemplate, bomTemplatesForType, layoutTemplateFromItem } from '../../lib/layoutTemplates.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { finishChoices } from './projectDefaults.js'

const num = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const pos = v => { const n = num(v); return n !== null && n > 0 }

// Template rules (bom_template_constraints) checked against one unit; values may be form strings.
export function evaluateConstraints(opening, constraints) {
  const w = Number(opening.width_m) || 0
  const h = Number(opening.height_m) || 0
  const panels = Number(opening.panel_count) || 1
  const violations = []
  for (const c of constraints || []) {
    if (c.rule_type === 'max_width_mm' && w * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_height_mm' && h * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_span_mm' && w * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_panel_count' && panels > c.value) violations.push(c.message)
  }
  return violations
}

// ---- type cascade (Ruling 22) ------------------------------------------------------------------------------
const activeTree = nodes => (nodes || []).filter(n => n.type.active !== false).map(n => ({ type: n.type, children: activeTree(n.children) }))
export const typeTreeOf = types => activeTree(buildTypeTree(types))

// [rootId, ..., typeId] top-down; [] for none.
export const typePath = (typesById, typeId) => (typeId ? typeAndAncestorIds(typesById, typeId).reverse() : [])

// The selects to show for a chosen path: level n+1 appears only when the node chosen at level n has children.
// leafId is the chosen type when it has no (active) children, else null.
export function cascadeLevels(tree, path) {
  const levels = []
  let nodes = tree || []
  let leafId = null
  for (let i = 0; i < 3 && nodes.length; i++) {
    const value = (path || [])[i] || ''
    levels.push({ options: nodes.map(n => ({ value: n.type.id, label: n.type.name })), value })
    const chosen = nodes.find(n => n.type.id === value)
    if (!chosen) break
    if (!chosen.children.length) { leafId = chosen.type.id; break }
    nodes = chosen.children
  }
  return { levels, leafId }
}

// The new path after picking `value` at `level` (deeper levels are dropped).
export const pickInPath = (path, level, value) => [...(path || []).slice(0, level), ...(value ? [value] : [])]

// BOM templates that build a type, keeping the item's current template listed even if it no longer fits.
export function templatesForType(templates, typeId, currentId) {
  const list = typeId ? bomTemplatesForType(templates, typeId) : []
  const cur = currentId ? (templates || []).find(t => t.id === currentId) : null
  return cur && !list.some(t => t.id === cur.id) ? [...list, cur] : list
}

// Add-on type choices: selectable types that have at least one add-on template the series can build.
export function addonTypeOptions(types, typesById, addonTemplates) {
  const have = new Set((addonTemplates || []).map(t => t.type_id).filter(Boolean))
  return selectableTypes(types).filter(t => have.has(t.id)).map(t => ({ value: t.id, label: typeLabel(typesById, t.id) }))
}

// ---- the item the screen costs and draws -------------------------------------------------------------------
// The payload (normalised values, exactly what will be saved). A half-filled add-on is "no add-on yet": left out
// of the live cost and drawing, never an error here (saving still asks for the missing add-on fields).
export function liveItem(form, projectId) {
  const p = buildOpeningPayload(form, { projectId })
  const addonPartial = !!form.has_addon && !(p.addon_template_id && p.addon_width_m > 0 && p.addon_height_m > 0)
  if (addonPartial) Object.assign(p, { addon_template_id: null, addon_width_m: null, addon_height_m: null, addon_panel_count: 1, addon_position: null, addon_offset_m: null })
  return { item: p, addonPartial }
}

export function validateExtraLines(lines) {
  for (const l of lines || []) {
    const amount = String(l.amount ?? '').trim()
    if (amount === '' || !Number.isFinite(Number(amount))) return 'จำนวนเงินของรายการเพิ่มเติมต้องเป็นตัวเลข'
    if (!String(l.description || '').trim()) return 'กรอกรายละเอียดของรายการเพิ่มเติม'
  }
  return null
}
export const validateItemForm = form => validateForm(form) || validateExtraLines(form.extra_lines)

// ---- dependent fields ---------------------------------------------------------------------------------------
// After any change: an own series must exist, an own colour must belong to the series' extruder, an own thickness
// must be one the series offers (a single one is set for the owner when the project's value does not fit), the
// sash thickness exists only where the series+type allows mixed thickness and is then always a real number
// (Ruling 21), and an own hardware set must be one the series offers for the type. Returns a new form.
export function reconcileItemForm(form, { index, project, template }) {
  const f = { ...form }
  const pj = project || {}
  if (f.series_id && !index.series[f.series_id]) f.series_id = ''
  const seriesId = f.series_id || pj.default_series_id || null
  if (f.alu_finish_id && !finishChoices(index, seriesId, pj.primary_provider_id).some(o => o.value === f.alu_finish_id)) f.alu_finish_id = ''
  const opts = seriesId ? thicknessesForSeries(index, seriesId) : []
  const has = v => opts.includes(Number(v))
  if (f.thickness_mm !== '' && opts.length && !has(f.thickness_mm)) f.thickness_mm = ''
  if (opts.length === 1 && f.thickness_mm === '' && !has(pj.default_thickness_mm)) f.thickness_mm = String(opts[0])
  const typeId = template && template.type_id
  const mixed = !!(typeId && seriesId && allowsMixedThickness(index, seriesId, typeId))
  if (!mixed || !has(f.sash_thickness_mm)) f.sash_thickness_mm = ''
  if (mixed && f.sash_thickness_mm === '') {
    const frame = f.thickness_mm !== '' ? f.thickness_mm : pj.default_thickness_mm
    const fill = has(pj.default_sash_thickness_mm) ? pj.default_sash_thickness_mm : (has(frame) ? frame : null)
    if (fill !== null && fill !== undefined) f.sash_thickness_mm = String(Number(fill))
  }
  if (f.hardware_set_id && seriesId && !hardwareSetsForSeries(index, seriesId, typeId).some(p => p.id === f.hardware_set_id)) f.hardware_set_id = ''
  return f
}

export const showSashField = (index, seriesId, template) => !!(template && template.type_id && seriesId && allowsMixedThickness(index, seriesId, template.type_id))

// What the disabled hardware select shows while "ใช้ค่าโปรเจกต์" is ticked (follows the template's type).
export function inheritedHardware({ packageItems, index, typeId, project }) {
  const hw = hardwareSetStatus(packageItems, index.types, typeId, project && project.default_hardware_set_id)
  const name = hw.set_id ? (index.parts[hw.set_id] ? index.parts[hw.set_id].name : 'ชุดที่ถูกลบแล้ว') : null
  if (hw.status === 'missing') return { ...hw, label: 'ยังไม่ได้กำหนดชุด', warning: 'ประเภทนี้ยังไม่ได้กำหนดชุดในโปรเจกต์' }
  if (hw.status === 'none') return { ...hw, label: 'ไม่ใช้ชุดอุปกรณ์', hint: 'ชุดอุปกรณ์โครงการกำหนดให้ประเภทนี้ไม่ใช้ชุด' }
  if (hw.status === 'set') return { ...hw, label: name, hint: 'ตามประเภทของรายการ จากชุดอุปกรณ์โครงการ' }
  return { ...hw, label: name || 'ไม่มีชุดอุปกรณ์', hint: 'โปรเจกต์ยังไม่ได้เลือกชุดอุปกรณ์โครงการ' }
}

// ---- drawing -------------------------------------------------------------------------------------------------
const WIDTH_RULES = new Set(['width', 'width_minus'])
const HEIGHT_RULES = new Set(['height', 'height_minus'])
// Part labels for the "parts" drawing: die no. (drawing_no, else the family) and cut length in mm of the first
// frame-role bar cut along the width (top/bottom) and along the height (left/right). components = the template's
// raw components, which computeBomForOpening maps one-to-one, in order, to bom.profileLines.
export function partLabels({ components, bom, index }) {
  if (!bom) return null
  const lines = bom.profileLines || []
  const pick = rules => {
    const i = (components || []).findIndex((c, k) => lines[k] && c.thickness_role !== 'sash' && rules.has(c.length_rule_type))
    if (i < 0) return null
    const l = lines[i]
    const p = l.profile_id ? index.profiles[l.profile_id] : null
    const die = (p && p.drawing_no) || l.family || ''
    return `${die} ${Math.round(Number(l.length_m) * 1000)}`.trim()
  }
  const h = pick(WIDTH_RULES)
  const v = pick(HEIGHT_RULES)
  if (!h && !v) return null
  return { top: h, bottom: h, left: v, right: v }
}

// ---- layout templates ----------------------------------------------------------------------------------------
const LAYOUT_REASON = {
  main_type_not_offered: 'ซีรีส์นี้ไม่มีประเภทชุดหลักนี้',
  addon_type_not_offered: 'ซีรีส์นี้ไม่มีประเภทของเพิ่มเติมของแม่แบบนี้',
  no_addon_template: 'ยังไม่มีเทมเพลต BOM ของประเภทของเพิ่มเติม',
}
const SAMPLE = { w: 1.5, h: 1.2 }

// Cards for the chosen main type: the applied proportions (on the current size, or a sample size for the
// thumbnail when none is typed yet), the add-on BOM template (first one of its type) and why a card is greyed.
export function layoutCards({ layoutTemplates, mainTypeId, seriesId, seriesTypes, addonTemplates, widthM, heightM }) {
  if (!mainTypeId) return []
  const sized = pos(widthM) && pos(heightM)
  const w = sized ? Number(widthM) : SAMPLE.w
  const h = sized ? Number(heightM) : SAMPLE.h
  return availableLayoutTemplates(layoutTemplates, { mainTypeId, seriesId, seriesTypes }).map(r => {
    const applied = applyLayoutTemplate(r.template, w, h)
    const addonTemplate = r.template.addon_type_id ? bomTemplatesForType(addonTemplates, r.template.addon_type_id)[0] || null : null
    let reason = r.reason
    if (!reason && r.template.addon_type_id && !addonTemplate) reason = 'no_addon_template'
    return { template: r.template, usable: !reason, reason, reasonText: reason ? LAYOUT_REASON[reason] : null, applied, addonTemplate, sized, sample: { w, h } }
  })
}

// The form after clicking a card. Sizes are filled only when the main size is known.
export function applyCardToForm(form, card) {
  const a = card.applied
  const f = { ...form, panel_count: String(a.main_panel_count || 1) }
  if (!a.addon_type_id || !card.addonTemplate) return { ...f, has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1', addon_position: 'top', addon_offset_m: '' }
  return {
    ...f, has_addon: true, addon_template_id: card.addonTemplate.id, addon_position: a.addon_position, addon_panel_count: String(a.addon_panel_count || 1),
    addon_width_m: card.sized ? String(a.addon_width_m) : '', addon_height_m: card.sized ? String(a.addon_height_m) : '',
    addon_offset_m: card.sized ? String(a.addon_offset_m) : '',
  }
}

// The estimation_layout_templates row to insert after the item saved, or null when it cannot be built.
export function layoutRowFromItem(item, { name, mainTypeId, addonTypeId }) {
  return layoutTemplateFromItem({
    name, mainTypeId, addonTypeId: item.addon_template_id ? addonTypeId : null, position: item.addon_position,
    widthM: Number(item.width_m), heightM: Number(item.height_m), addonWidthM: Number(item.addon_width_m), addonHeightM: Number(item.addon_height_m),
    offsetM: item.addon_offset_m === null || item.addon_offset_m === undefined ? null : Number(item.addon_offset_m),
    mainPanels: Number(item.panel_count) || 1, addonPanels: Number(item.addon_panel_count) || 1,
  })
}

export function layoutSaveErrorText(error) {
  const e = error || {}
  if (e.code === '23505' || /duplicate key|unique/i.test(String(e.message || ''))) return 'มีแม่แบบรูปแบบชื่อนี้แล้ว ตั้งชื่ออื่นแล้วบันทึกอีกครั้ง'
  return 'บันทึกแม่แบบรูปแบบไม่สำเร็จ: ' + (e.message || String(error))
}

// ---- quotation description -------------------------------------------------------------------------------------
// The context buildItemDescription reads, from the live item and its resolved (inherited) values.
export function descriptionContext({ item, resolved, index, template, infillTypesById }) {
  const r = resolved || {}
  const series = r.series_id ? index.series[r.series_id] : null
  const typeNames = template && template.type_id ? typePath(index.types, template.type_id).map(id => (index.types[id] || {}).name).filter(Boolean).join(' ') : ''
  return {
    item_name: item.item_name || '', type_name: typeNames || (template ? template.name : ''),
    width_m: Number(item.width_m) || 0, height_m: Number(item.height_m) || 0,
    series_label: series ? seriesLabelFull(series, index.providers[series.provider_id]) : '',
    finish_name: r.finish_id && index.finishes[r.finish_id] ? index.finishes[r.finish_id].name : '',
    thickness_mm: r.thickness_mm, infill_name: r.infill_type_id && (infillTypesById || {})[r.infill_type_id] ? infillTypesById[r.infill_type_id].name : '',
    hardware_set_name: r.hardware_set_id && index.parts[r.hardware_set_id] ? index.parts[r.hardware_set_id].name : '',
  }
}
