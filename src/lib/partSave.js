// src/lib/partSave.js
// DB rows <-> part-editor model (see partModel.js). This half LOADS: the four part tables
// (bom_template_parts -> bom_template_positions -> bom_template_position_profiles -> bom_template_piece_ends)
// become one model per template. Pure. Rows may be partial (a save cut short, a hand edit, an older row): anything
// missing is filled with the layout's defaults so the result is always a valid model; costing then reports what is
// incomplete (an empty profile family, a butt end without a target) instead of dropping it.
import { LAYOUTS, startModel, ensureEnds } from './partModel.js'

const num = v => (v === null || v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const RULES = new Set(['width', 'height', 'width_minus', 'height_minus', 'perimeter'])
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)

function lineFromRow(row, def) {
  const ded = num(row.length_deduction_mm)
  const factor = num(row.length_factor)
  const qty = num(row.quantity_value)
  return {
    profile_family: String(row.profile_family ?? '').trim(),
    length_rule_type: RULES.has(row.length_rule_type) ? row.length_rule_type : def.length_rule_type,
    length_deduction_mm: ded !== null && ded >= 0 ? ded : 0,
    deduction_auto: typeof row.deduction_auto === 'boolean' ? row.deduction_auto : def.deduction_auto,
    length_factor: factor !== null && factor > 0 ? factor : 1,
    quantity_value: qty !== null && qty >= 0 ? qty : 1,
    thickness_role: row.thickness_role === 'sash' ? 'sash' : null,
    ends: [],
  }
}

// { template, parts, positions, lines, ends } -> model | null. null only for a template without a (known) layout_kind.
// The row arrays may hold every tenant row: only the rows reached from this template are used.
export function modelFromRows({ template, parts, positions, lines, ends } = {}) {
  const kind = template && template.layout_kind
  if (!kind || !LAYOUTS[kind]) return null
  const layout = LAYOUTS[kind]
  const model = startModel(kind)   // defaults for every part / position / line / end
  const defaults = startModel(kind)

  // parts of this template, first row per part_key by sort_order
  const partRows = {}
  for (const r of [...(parts || [])].filter(p => p.template_id === template.id).sort(bySort)) {
    if (!partRows[r.part_key]) partRows[r.part_key] = r
  }
  model.parts = model.parts.map(p => {
    const r = partRows[p.key]
    if (!r) return p
    const count = Math.floor(Number(r.count))
    const overlap = num(r.overlap_mm)
    return {
      key: p.key,
      name: String(r.name ?? '').trim() || p.name,
      count: Number.isFinite(count) && count >= 1 ? count : p.count,
      overlap_mode: r.overlap_mode === 'auto_hook' || r.overlap_mode === 'manual' ? r.overlap_mode : p.overlap_mode,
      overlap_mm: overlap !== null && overlap >= 0 ? overlap : 0,
    }
  })

  // positions of those parts (a position must sit under its own part)
  const partKeyById = {}
  for (const [key, r] of Object.entries(partRows)) partKeyById[r.id] = key
  const posRows = {}
  for (const r of [...(positions || [])].sort(bySort)) {
    const pos = layout.positions[r.position_key]
    if (!pos || partKeyById[r.part_id] !== pos.part || posRows[r.position_key]) continue
    posRows[r.position_key] = r
  }

  // profile lines per position; remember row id -> { key, line } for butt targets
  const where = {}
  const lineRowsByKey = {}
  const keyByPosId = {}
  for (const [key, r] of Object.entries(posRows)) keyByPosId[r.id] = key
  for (const r of [...(lines || [])].sort(bySort)) {
    const key = keyByPosId[r.position_id]
    if (!key) continue
    ;(lineRowsByKey[key] = lineRowsByKey[key] || []).push(r)
  }
  for (const key of layout.order) {
    const pr = posRows[key]
    if (pr && String(pr.name ?? '').trim()) model.names[key] = String(pr.name).trim()
    const rows = lineRowsByKey[key]
    if (!rows || !rows.length) continue   // keep the default line (empty family -> reported by the expander)
    const def = defaults.lines[key][0]
    model.lines[key] = rows.map((r, i) => { where[r.id] = { key, line: i }; return lineFromRow(r, def) })
  }

  // piece ends; a hole (missing piece or end) gets the position's default pair, ensureEnds then fits the piece count
  const endRows = {}
  for (const r of ends || []) if (where[r.position_profile_id]) (endRows[r.position_profile_id] = endRows[r.position_profile_id] || []).push(r)
  for (const [id, rows] of Object.entries(endRows)) {
    const { key, line } = where[id]
    const defPair = defaults.lines[key][0].ends[0]
    const pairs = []
    for (const r of rows) {
      const piece = Math.floor(Number(r.piece_index))
      const end = Number(r.end_index)
      if (!(piece >= 0) || (end !== 0 && end !== 1)) continue
      const d = num(r.deduction_mm)
      pairs[piece] = pairs[piece] || [null, null]
      pairs[piece][end] = {
        mode: r.mode === 'butt' ? 'butt' : 'through',
        to: r.mode === 'butt' && r.butt_to_profile_id && where[r.butt_to_profile_id] ? { ...where[r.butt_to_profile_id] } : null,
        deduction_mm: r.mode === 'butt' && d !== null && d >= 0 ? d : null,
      }
    }
    model.lines[key][line].ends = Array.from(pairs, p => [0, 1].map(e => (p && p[e]) || { ...defPair[e], to: defPair[e].to ? { ...defPair[e].to } : null }))
  }
  // a line without any end rows: line 0 gets the default pairs, later lines copy line 0 (ensureEnds)
  for (const key of layout.order) {
    model.lines[key].forEach((l, i) => {
      if (!l.ends.length && i === 0) l.ends = defaults.lines[key][0].ends.map(p => p.map(e => ({ ...e, to: e.to ? { ...e.to } : null })))
    })
  }
  return ensureEnds(model)
}

// { [templateId]: model } for every template with a layout_kind (the shape costOpening's ctx.partModelByTemplate expects).
export function partModelsByTemplate({ templates, parts, positions, lines, ends } = {}) {
  const out = {}
  for (const t of templates || []) {
    const m = modelFromRows({ template: t, parts, positions, lines, ends })
    if (m) out[t.id] = m
  }
  return out
}
