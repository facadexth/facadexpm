// src/pages/estimation/itemForm.js
// Pure helpers for the item popup (mockup screen 2): type cascade, dependent-field reconciliation, the live item
// the cost and drawing are computed from, the project hardware set shown while inheriting, part labels for the
// "parts" drawing, layout-template cards and the quotation description context. No React, no Supabase.
import { buildTypeTree, typeAndAncestorIds, typeLabel, selectableTypes } from '../../lib/typeTree.js'
import { thicknessesForSeries, allowsMixedThickness } from '../../lib/estimationCatalogViews.js'
import { buildOpeningPayload, validateForm, mmText } from '../../lib/openingPayload.js'
import { hardwareSetStatus } from '../../lib/projectHardware.js'
import { availableLayoutTemplates, applyLayoutTemplate, bomTemplatesForType, layoutTemplateFromItem } from '../../lib/layoutTemplates.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { frameFamily } from '../../lib/itemPreviewSignature.js'
import { coerceParams, inputsOf, LAYOUTS } from '../../lib/layoutRegistry.js'
import { modelForItem } from '../../lib/openingCost.js'
import { visibleInputs, clampedParts } from '../bomTemplates/partEditorView.js'
import { validateAddons, addonDims } from '../../lib/addonModel.js'

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
// `all` (optional) = every template incl. inactive ones, so a saved template that is inactive / typeless / not
// offered still shows as the selected value.
export function templatesForType(templates, typeId, currentId, all) {
  const list = typeId ? bomTemplatesForType(templates, typeId) : []
  const cur = currentId ? (all || templates || []).find(t => t.id === currentId) : null
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
// opts.template = the item's main BOM template (its layout_kind decides whether inline add-ons are allowed).
export function validateItemForm(form, { template = null } = {}) {
  const base = validateForm(form) || validateExtraLines(form.extra_lines)
  if (base) return base
  const addons = form.addons || []
  if (!addons.length) return null
  if (form.has_addon && form.addon_template_id) return 'มีชุดต่อเติมแบบเดิมอยู่ ให้แปลงหรือลบก่อน'
  if (template && !template.layout_kind) return 'template นี้ไม่ได้ใช้ part editor จึงใส่ช่องแสงไม่ได้'
  return validateAddons(addons, mainMmOf(form))
}

// ---- inline add-ons (ช่องแสง) ---------------------------------------------------------------------------------
// The form's main size in mm ({ widthMm, heightMm }, null when not typed).
export const mainMmOf = form => ({ widthMm: num(form.width_m), heightMm: num(form.height_m) })

// The legacy single add-on ("ชุดต่อเติม": addon_template_id + sizes) as one new attach add-on (AO-7): the legacy
// width runs along a top / bottom edge, the height along a left / right one; the legacy fields are cleared.
export function convertLegacyAddon(form) {
  const pos = ['top', 'bottom', 'left', 'right'].includes(form.addon_position) ? form.addon_position : 'top'
  const horizontal = pos === 'top' || pos === 'bottom'
  const w = num(form.addon_width_m)
  const h = num(form.addon_height_m)
  const cols = Math.floor(Number(form.addon_panel_count)) >= 1 ? Math.floor(Number(form.addon_panel_count)) : 1
  const addon = {
    mode: 'attach', kind: 'fixed', position: pos, len_mm: horizontal ? w : h, thick_mm: horizontal ? h : w,
    offset_mm: Number(form.addon_offset_m) || 0, align: 'start', rows: 1, cols,
  }
  return {
    ...form, addons: [...(form.addons || []), addon],
    has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1', addon_offset_m: '',
  }
}

// The add-ons the live cost and drawing can use (each passes validateAddons on its own) and, per kept add-on, its
// index in the form (indexOf[i] = form index), so cost lines and issues are numbered as the estimator sees them.
export function liveAddons(addons) {
  const kept = []
  const indexOf = []
  ;(addons || []).forEach((a, i) => { if (!validateAddons([a])) { kept.push(a); indexOf.push(i) } })
  return { addons: kept, indexOf }
}

// Cost-summary lines of the inline add-ons: one per attach add-on (its own BOM total) and one for the merge add-ons'
// glass (merge frame pieces are already lines of the main BOM), so these plus the main BOM sum to the total.
export function addonCostLines(cost, indexOf) {
  const c = cost || {}
  const n = i => ((indexOf || [])[i] ?? i) + 1
  const lines = (c.addonBoms || []).map(a => ({ key: `ao${a.addonIndex}`, label: `ช่องแสง ${n(a.addonIndex)} (แยกวงกบ)`, value: a.bom.totalCost }))
  const g = c.addonMerge && c.addonMerge.glass
  if (g && g.panes > 0) lines.push({ key: 'aoglass', label: `กระจกช่องแสง (ร่วมวงกบ) ${Number(g.area_sqm).toFixed(2)} ตร.ม.`, value: g.cost })
  return lines
}

// Per add-on: a Thai warning when offset + length runs past its edge (the main edge plus every perpendicular
// add-on's thickness, as addonExpand's range check), else null.
export function addonRangeWarnings(addons, main) {
  const list = addons || []
  const isH = p => p === 'top' || p === 'bottom'
  return list.map((a, i) => {
    let edge = isH(a.position) ? num(main && main.widthMm) : num(main && main.heightMm)
    if (edge === null || num(a.len_mm) === null) return null
    for (const o of list) if (o && isH(o.position) !== isH(a.position)) edge += Math.max(0, num(o.thick_mm) ?? 0)
    return (num(a.offset_mm) ?? 0) + num(a.len_mm) > edge ? `ช่องแสง ${i + 1} ยาวเกินขอบ (${edge} มม.)` : null
  })
}

// One-line summary of an add-on row (mockup: โหมด · ชนิด · ตำแหน่ง · w × h มม. · rows × cols ช่อง · เสมอ...).
export const addonSize = a => { const d = addonDims(a); const t = v => (num(v) === null ? '?' : String(num(v))); return `${t(d.w)} × ${t(d.h)}` }

// ---- dependent fields ---------------------------------------------------------------------------------------
// Fills only, never clears (an own value the series does not offer stays and is shown as "(ไม่มีในซีรีส์นี้)",
// so what the screen costs is what will be saved, and opening an old item changes nothing by itself):
// - a series with a single thickness gets it as the item's own value when the series changed (or on a new item)
//   and the project's thickness does not fit;
// - where the series+type allows mixed thickness, a blank sash is filled with the resolved frame thickness only
//   when the frame changed or on a new item (Ruling 21: where shown it holds a real number).
// prev = the form before this change, next = after it.
export function reconcileItemForm(prev, next, { index, project, template, isNew }) {
  const f = { ...next }
  const p = prev || {}
  const pj = project || {}
  const seriesId = f.series_id || pj.default_series_id || null
  const opts = seriesId ? thicknessesForSeries(index, seriesId) : []
  const has = v => v !== '' && v !== null && v !== undefined && opts.includes(Number(v))
  const seriesChanged = (p.series_id || '') !== (f.series_id || '')
  if ((seriesChanged || isNew) && f.thickness_mm === '' && opts.length === 1 && !has(pj.default_thickness_mm)) f.thickness_mm = String(opts[0])
  const frameChanged = (p.thickness_mm || '') !== (f.thickness_mm || '')
  const typeId = template && template.type_id
  const mixed = !!(typeId && seriesId && allowsMixedThickness(index, seriesId, typeId))
  if (mixed && f.sash_thickness_mm === '' && (frameChanged || isNew)) {
    const frame = f.thickness_mm !== '' ? f.thickness_mm : pj.default_thickness_mm
    if (has(frame)) f.sash_thickness_mm = String(Number(frame))
  }
  return f
}

// Options + the item's own value when it is not among them, marked so the owner sees it is not offered.
export function withCurrent(options, value, label, note = '(ไม่มีในซีรีส์นี้)') {
  if (value === '' || value === null || value === undefined || options.some(o => String(o.value) === String(value))) return options
  return [...options, { value: String(value), label: `${label || value} ${note}`, missing: true }]
}

// Waste is a share of the aluminium, infill a price per area: neither can be shown as a number while what it is
// computed from is unresolved ("—", never 0.00).
export function costRowFlags(cost, bom) {
  const lines = bom ? [...(bom.profileLines || []), ...(bom.gridLines || [])] : []
  const infillBad = (cost && cost.unresolved || []).some(u => u.reason === 'unknown_infill')
  return { wasteKnown: lines.every(l => l.resolved), infillKnown: !infillBad }
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
// Part labels for the "parts" drawing: die no. (drawing_no, else the family) and cut length in mm of the frame bar
// cut along the width (top/bottom) and along the height (left/right). The frame family comes from the SAME picker
// as the drawn frame width (frameFamily); a side without a bar of that family falls back to its first non-sash bar.
// components = the template's raw components, mapped one-to-one, in order, to bom.profileLines.
export function partLabels({ components, joints, bom, index }) {
  if (!bom) return null
  const lines = bom.profileLines || []
  const fam = frameFamily(components, joints)
  const pick = rules => {
    const ok = (c, k) => lines[k] && c.thickness_role !== 'sash' && rules.has(c.length_rule_type)
    const all = components || []
    let i = all.findIndex((c, k) => ok(c, k) && String(c.profile_family ?? '').trim() === fam)
    if (i < 0) i = all.findIndex(ok)
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

// The form after clicking a card (form sizes are millimetre text). Sizes are filled only when the main size is known.
export function applyCardToForm(form, card) {
  const a = card.applied
  const f = { ...form, panel_count: String(a.main_panel_count || 1) }
  if (!a.addon_type_id || !card.addonTemplate) return { ...f, has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1', addon_position: 'top', addon_offset_m: '' }
  return {
    ...f, has_addon: true, addon_template_id: card.addonTemplate.id, addon_position: a.addon_position, addon_panel_count: String(a.addon_panel_count || 1),
    addon_width_m: card.sized ? mmText(a.addon_width_m) : '', addon_height_m: card.sized ? mmText(a.addon_height_m) : '',
    addon_offset_m: card.sized ? mmText(a.addon_offset_m) : '',
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

// The item form's layout inputs (Task 10): for a layout_kind template whose model is loaded, the estimator inputs the
// type does not fix (awning rows / cols are the type's, never shown), only_when applied, `cells` excluded (cycled on the
// preview). values = template params overridden by the item's own (coerced) layout_params, exactly as costing applies
// them (openingCost.modelForItem); invalid = the layout refuses them (folding 0 + 0); clamped = parts above 10 pieces.
// null for a legacy template, a missing / refused template model, or a kind without such inputs and without cells.
export function itemLayoutInputs(baseModel, layoutParams) {
  if (!baseModel || baseModel.error || !LAYOUTS[baseModel.layout_kind]) return null
  const kind = baseModel.layout_kind
  const own = coerceParams(kind, layoutParams)
  const values = { ...(baseModel.params || {}) }
  const fixedKeys = baseModel.fixedKeys || []   // the inputs the type pins (R-F2)
  for (const inp of inputsOf(kind)) if (inp.estimator && !fixedKeys.includes(inp.key) && inp.key in own) values[inp.key] = own[inp.key]
  const inputs = visibleInputs(kind, values, { item: true, fixedKeys })
  const cells = !!LAYOUTS[kind].cells
  if (!inputs.length && !cells) return null
  const model = modelForItem(baseModel, { layout_params: layoutParams })
  const invalid = !!(model && model.error)
  return { kind, inputs, values, invalid, clamped: invalid ? [] : clampedParts(model), cells }
}
