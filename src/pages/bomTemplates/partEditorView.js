// src/pages/bomTemplates/partEditorView.js
// Pure view data for the BOM template part editor (PartEditor.jsx and its children). Every number comes from the
// libraries: lengths from expandParts + bomEngine.computeComponentLength, deductions and the "ที่มา" line from
// partExpand, butt distance / width from openingCost.buttOfFor / widthOfFor at the TEST series + thickness
// (Ruling PE-3: local UI state, never saved). Nothing here re-derives a formula.
import { expandParts, explainPiece, lineDeductions, sashOverlap, endDeduction, fmtMm } from '../../lib/partExpand.js'
import { computeComponentLength } from '../../lib/bomEngine.js'
import { buttOfFor, widthOfFor } from '../../lib/openingCost.js'
import { resolveCatalogProfile } from '../../lib/aluCatalogPricing.js'
import { thicknessesForSeries } from '../../lib/estimationCatalogViews.js'
import { LAYOUTS, validateCorners, lineFamily, MAX_PART_COUNT } from '../../lib/partModel.js'
import { exprParams, inputsOf } from '../../lib/layoutRegistry.js'
import { evalExpr } from '../../lib/layoutExpr.js'
import { pieceLabel as geomPieceLabel } from '../../lib/partGeometry.js'
import { DEFAULT_SETTINGS } from '../../lib/estimationSettings.js'

export const RULE_LABELS = { width: 'กว้าง', height: 'สูง', width_minus: 'กว้าง − ระยะหัก', height_minus: 'สูง − ระยะหัก', perimeter: 'เส้นรอบรูป' }
export const DEDUCTING = new Set(['width_minus', 'height_minus'])
export const ISSUE_TEXT = {
  no_profile_family: 'ยังไม่ได้เลือกอลูมิเนียม จึงยังคิดความยาวไม่ได้',
  no_butt_distance: 'ยังไม่มีระยะชนของโปรไฟล์ที่ถูกชน (ที่ซีรีส์/ความหนาที่ใช้ทดสอบ) จึงหักเป็น 0',
  no_butt_target: 'ปลายวิ่งชนยังไม่ได้เลือกชิ้นที่ชน',
  corner_violation: 'มุมที่สองชิ้นมาพบกันต้องมีชิ้นหนึ่งวิ่งสุด อีกชิ้นวิ่งชน',
  no_model: 'ยังไม่มีข้อมูลชิ้นส่วน',
  no_profile_width: 'ไม่มีความกว้างโปรไฟล์ของซอยกลาง/mullion — ใส่ width_mm ในแคตตาล็อก',
}

// ---------------------------------------------------------------- Task 10: every layout kind

// Shown in the inputs panel when an expression part count (awning rows × cols, curtain-wall awning cells) is above
// MAX_PART_COUNT: pieceCount clamps it, so costing prices 10 sashes.
// Shown instead of the drawing when the layout refuses the params (startModel / setParams throw layout_params_invalid:
// folding door nL + nR = 0).
export const PARAMS_HINT = 'ใส่จำนวนบานซ้าย/ขวา (รวมกันต้องมากกว่า 0)'

export const CLAMP_TEXT = `จำนวนบานเกิน ${MAX_PART_COUNT} — คิดราคาที่ ${MAX_PART_COUNT} บาน`

const clampCount = (x) => (Number.isFinite(x) ? Math.min(MAX_PART_COUNT, Math.max(0, Math.round(x))) : 0)

// { count, raw, expr } of one part: `raw` the layout's count over the params (or the stored literal), `count` the
// value pieceCount uses (clamped 0..MAX_PART_COUNT), `expr` true when the layout count is an expression (read-only, R-9c).
export function partCountOf(model, partKey) {
  const def = layoutOf(model)?.parts.find((p) => p.key === partKey)
  const rec = model?.parts?.find((p) => p.key === partKey)
  const expr = !!def && typeof def.count === 'string'
  let raw = 0
  try { raw = Number(evalExpr(expr ? def.count : (rec?.count ?? def?.count ?? 1), exprParams(model))) } catch { raw = 0 }
  return { count: clampCount(raw), raw, expr }
}

// Parts whose expression count is above MAX_PART_COUNT: [{ key, name, raw, used }].
export function clampedParts(model) {
  const layout = layoutOf(model)
  if (!layout) return []
  return layout.parts.filter((d) => typeof d.count === 'string').map((d) => {
    const c = partCountOf(model, d.key)
    return { key: d.key, name: model.parts.find((p) => p.key === d.key)?.name || d.name, raw: c.raw, used: c.count }
  }).filter((x) => x.raw > x.used)
}

// Part tabs (D13, mockup v5): ทั้งชุด, then one tab per part instance (model.parts × count). A part without positions
// (frameless glass leaves / panes, curtain-wall spandrel panels) has no aluminium to assign, so no tab.
export function partTabs(model) {
  const layout = layoutOf(model)
  const tabs = [{ id: 'all', partKey: null, partIdx: null, label: 'ทั้งชุด' }]
  if (!layout) return tabs
  for (const def of layout.parts) {
    if (!def.positions?.length) continue
    const name = model.parts.find((p) => p.key === def.key)?.name || def.name
    const { count } = partCountOf(model, def.key)
    for (let i = 0; i < count; i++) tabs.push({ id: `${def.key}:${i}`, partKey: def.key, partIdx: i, label: count > 1 ? `${name} ${i + 1}` : name })
  }
  return tabs
}

// R-4a: an input with only_when { key: value } is shown only while every listed param equals its value.
export function inputVisible(inp, params) {
  const p = params || {}
  return Object.entries(inp.only_when || {}).every(([k, v]) => p[k] === v || (typeof v === 'number' && Number(p[k]) === v))
}

// Inputs of the inputs panel. Template editor: every input except `cells` (that one is the click cycling on the
// preview); the ones the type pins (fixedKeys = model.fixedKeys, R-F2) are shown read-only by the panel. Item form
// ({ item: true }): estimator inputs the type does not pin, again without cells (awning rows / cols are not estimator
// inputs: never on the item).
export function visibleInputs(kind, params, { item = false, fixedKeys = [] } = {}) {
  return inputsOf(kind).filter((inp) => inp.type !== 'cells'
    && (!item || (inp.estimator && !fixedKeys.includes(inp.key)))
    && inputVisible(inp, params))
}

// "เสร็จแล้ว" per part (D13): model.done = [partKey] (UI meaning only; saved in the template's layout_params._done).
export const isDone = (model, partKey) => Array.isArray(model?.done) && model.done.includes(partKey)
export function toggleDone(model, partKey) {
  const done = Array.isArray(model.done) ? model.done : []
  return { ...model, done: done.includes(partKey) ? done.filter((k) => k !== partKey) : [...done, partKey] }
}

// Overview badge: present positions whose first profile line has a family / all present positions.
export function assignedCount(model) {
  const layout = layoutOf(model)
  const keys = layout ? layout.order.filter((k) => model.lines?.[k]) : []
  return { done: keys.filter((k) => lineFamily(model, k, 0)).length, total: keys.length }
}

export const fmt = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? '—' : fmtMm(Number(x), d))
export const fmtCount = (n) => fmt(n, n % 1 ? 1 : 0)
export const STOCK_M = DEFAULT_SETTINGS.stock_length_m

const layoutOf = (model) => (model ? LAYOUTS[model.layout_kind] : null)
export const posName = (model, key) => model?.names?.[key] || layoutOf(model)?.positions[key]?.name || key
export const partOfKey = (model, key) => layoutOf(model)?.positions[key]?.part
export const orientOf = (model, key) => layoutOf(model)?.positions[key]?.orient || 'h'
export const endLabels = (model, key) => (orientOf(model, key) === 'h' ? ['ซ้าย', 'ขวา'] : ['บน', 'ล่าง'])

// Same piece labels as the drawing ("ซ้าย"/"ขวา", "บานซ้าย"/"บานขวา", "ชิ้นที่ n", '').
export function pieceLabel(model, key, piece) {
  const layout = layoutOf(model)
  return layout && layout.positions[key] ? geomPieceLabel(model, layout, key, piece) : ''
}

// "เฟรมล่าง" or "เฟรมล่าง › โปรไฟล์ที่ 2" when the position has several profiles (mockup refName).
export function refName(model, ref) {
  if (!ref) return ''
  const n = model.lines?.[ref.key]?.length || 0
  return posName(model, ref.key) + (n > 1 ? ' › โปรไฟล์ที่ ' + (ref.line + 1) : '')
}

// Test series options (every active series) and thickness options of the chosen series.
export function testOptions(index, seriesId) {
  const series = Object.values(index?.series || {}).filter((s) => s && s.active !== false)
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th'))
  return { series, thicknesses: index && seriesId ? thicknessesForSeries(index, seriesId) : [] }
}

// Initial test pick: the first series offering the template's type (else the first series) and its first thickness.
export function defaultTestPick(index, typeId) {
  const { series } = testOptions(index, null)
  const ofType = typeId ? series.filter((s) => (index.seriesTypesBySeries?.[s.id] || []).some((l) => l.type_id === typeId)) : []
  const s = ofType[0] || series[0]
  if (!s) return { seriesId: '', thicknessMm: null }
  return { seriesId: s.id, thicknessMm: thicknessesForSeries(index, s.id)[0] ?? null }
}

// Everything the editor shows, computed once per render.
export function editorView({ model, index, seriesId, thicknessMm, widthMm, heightMm }) {
  const opts = { index, seriesId, thicknessMm: Number(thicknessMm) || null }
  const buttOf = buttOfFor(opts)
  const widthOf = widthOfFor(opts)
  const profileOf = (family) => {
    const f = String(family ?? '').trim()
    if (!index || !seriesId || !f || !(Number(thicknessMm) > 0)) return null
    return resolveCatalogProfile(index, seriesId, f, Number(thicknessMm)).profile
  }
  const W = Math.max(0, Number(widthMm) || 0), H = Math.max(0, Number(heightMm) || 0)
  const exp = expandParts({ model, buttOf, widthOf })
  const layout = layoutOf(model)

  // per position line: groups of length × quantity
  const lines = {}
  for (const key of layout ? layout.order : []) {
    lines[key] = (model.lines[key] || []).map((l, li) => {
      const fam = lineFamily(model, key, li)   // own family, else the layout's familyFrom (sliding_n middle / right sashes)
      const p = profileOf(fam)
      const kgPerM = p && Number(p.linear_weight_kg_per_m) > 0 ? Number(p.linear_weight_kg_per_m) : null
      return { family: fam, unresolved: fam ? null : 'no_profile_family', kgPerM, raw: [] }
    })
  }
  exp.components.forEach((c, i) => {
    const src = exp.sources?.[i]
    const r = src && lines[src.key]?.[src.line]
    if (!r) return
    const lenMm = Math.max(0, computeComponentLength(c.length_rule_type, c.length_deduction_mm, W / 1000, H / 1000, c.length_factor, c.end_deduction_mm) * 1000)
    r.raw.push({ len: lenMm, n: Number(c.quantity_value) || 0 })
  })
  for (const key of Object.keys(lines)) {
    for (const r of lines[key]) {
      const m = new Map()
      for (const g of r.raw) {
        const k = Math.round(g.len * 10) / 10
        m.set(k, (m.get(k) || 0) + g.n)
      }
      r.groups = [...m.entries()].sort((a, b) => b[0] - a[0]).map(([len, n]) => {
        const totalM = (len * n) / 1000
        return { len, n, totalM, kg: r.kgPerM != null ? totalM * r.kgPerM : null }
      })
      r.totalM = r.groups.reduce((s, g) => s + g.totalM, 0)
      r.kg = r.kgPerM != null ? r.groups.reduce((s, g) => s + g.kg, 0) : null
      r.bars = Math.ceil(r.totalM / STOCK_M - 1e-9)
      delete r.raw
    }
  }

  const positionTotal = (key) => (lines[key] || []).reduce((t, r) => ({
    totalM: t.totalM + r.totalM, kg: t.kg + (r.kg || 0), bars: t.bars + r.bars, kgAny: t.kgAny || r.kg != null,
  }), { totalM: 0, kg: 0, bars: 0, kgAny: false })

  const parts = (layout ? layout.parts : []).map((def) => {
    const rec = model.parts.find((p) => p.key === def.key) || def
    const keys = def.positions
    const t = keys.reduce((a, k) => { const x = positionTotal(k); return { totalM: a.totalM + x.totalM, kg: a.kg + x.kg, kgAny: a.kgAny || x.kgAny } }, { totalM: 0, kg: 0, kgAny: false })
    return { key: def.key, name: rec.name, count: partCountOf(model, def.key).count, done: isDone(model, def.key), keys, ...t }
  })

  // An issue belongs to a position by its key when it carries one, else by the exact position name (the expander
  // reports issues under the position name, never with a piece label).
  const positionIssues = (key) => {
    const name = posName(model, key)
    const out = new Set()
    for (const is of exp.issues) if (is.key != null ? is.key === key : is.role_name === name) out.add(is.reason)
    return [...out]
  }

  return {
    W, H, buttOf, widthOf, profileOf, lines, parts, positionTotal, positionIssues,
    issues: exp.issues,
    corners: model ? validateCorners(model) : [],
    explain: (key, lineIdx, piece) => explainPiece({ model, buttOf, widthOf, key, lineIdx, piece, widthMm: W, heightMm: H }),
    deductions: (key, lineIdx) => lineDeductions({ model, buttOf, widthOf, key, lineIdx }),
    overlap: () => sashOverlap({ model, buttOf, widthOf }),
    endDed: (end) => endDeduction({ model, buttOf, widthOf, end }),
    buttOfLine: (ref) => {
      const fam = ref && model.lines?.[ref.key]?.[ref.line]?.profile_family
      return fam ? buttOf(fam) : null
    },
  }
}

// Mockup note under a sash position: how the automatic frame deduction is made (numbers from the frame profiles).
export function positionNote(model, view, key) {
  if (model.layout_kind !== 'sliding_2') return ''   // the wording below is the two-sash sliding window's
  const b = (k) => view.buttOfLine({ key: k, line: 0 })
  const n = (v) => (v == null ? '?' : fmt(v))
  if (key === 'sash_top' || key === 'sash_bottom') {
    const fs = b('frame_side')
    return `บานอยู่ในช่องเปิดของวงกบ: หักเฟรมข้าง 2 × ${n(fs)} = ${fs == null ? '?' : fmt(2 * fs)} ก่อน แล้ว × 0.5 ต่อบาน แล้วหักระยะชนเสาที่ปลาย (แก้ค่าได้)`
  }
  if (key === 'key_stile' || key === 'hook_stile') {
    const ft = b('frame_top'), fb = b('frame_bottom')
    return `บานอยู่ในช่องเปิดของวงกบ: หักเฟรมบน ${n(ft)} + เฟรมล่าง ${n(fb)} = ${ft == null || fb == null ? '?' : fmt(ft + fb)} (แก้ค่าได้ เช่น เผื่อระยะเคลียร์)`
  }
  return ''
}

// "สุด/ชน · สุด/ชน" per piece (mockup endTxt).
const END_SHORT = (e) => (e?.mode === 'through' ? 'สุด' : e?.mode === 'mitre' ? '45°' : 'ชน')
export function endText(line) {
  return (line.ends || []).map((p) => END_SHORT(p?.[0]) + '/' + END_SHORT(p?.[1])).join(' · ')
}
