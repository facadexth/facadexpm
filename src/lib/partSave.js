// src/lib/partSave.js
// DB rows <-> part-editor model (see partModel.js). modelFromRows LOADS: the four part tables
// (bom_template_parts -> bom_template_positions -> bom_template_position_profiles -> bom_template_piece_ends)
// become one model per template. Pure. Rows may be partial (a save cut short, a hand edit, an older row): anything
// missing is filled with the layout's defaults so the result is always a valid model; costing then reports what is
// incomplete (an empty profile family, a butt end without a target) instead of dropping it.
// modelToRows / validateModel / saveModel / loadModel are the SAVE half (and a one-template loader for the editor).
import { LAYOUTS, startModel, ensureEnds, pieceCount, validateCorners } from './partModel.js'

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

// ---------------------------------------------------------------- save half

const PART_TABLES = {
  parts: 'bom_template_parts', positions: 'bom_template_positions',
  lines: 'bom_template_position_profiles', ends: 'bom_template_piece_ends',
}
const isNum = v => typeof v === 'number' && Number.isFinite(v)
const nonNeg = v => (isNum(v) && v >= 0 ? v : null)
const lineExists = (model, to) => !!(to && model.lines[to.key] && Number.isInteger(to.line) && to.line >= 0 && to.line < model.lines[to.key].length)

// model -> { parts, positions, lines, ends } insert rows (the inverse of modelFromRows). Ids are generated here so
// one insert per table wires every FK (part_id, position_id, position_profile_id, butt_to_profile_id).
// Explicit column whitelist (editor-only keys never reach PostgREST; tenant_id is left to its DB default).
// A butt target {key,line} that names no line of this model is written as null (the loader then reports it).
export function modelToRows(model, templateId, newId = () => crypto.randomUUID()) {
  const layout = LAYOUTS[model.layout_kind]
  if (!layout) throw new Error(`unknown layout ${model.layout_kind}`)
  const m = ensureEnds(model)
  const out = { parts: [], positions: [], lines: [], ends: [] }
  const lineIds = {}   // key -> [row id per line]
  for (const key of layout.order) lineIds[key] = (m.lines[key] || []).map(() => newId())

  m.parts.forEach((p, pi) => {
    const def = layout.parts.find(d => d.key === p.key)
    if (!def) return
    const partId = newId()
    out.parts.push({
      id: partId, template_id: templateId, part_key: p.key,
      name: String(p.name ?? '').trim() || def.name,
      count: Math.max(1, Math.floor(Number(p.count)) || 1),
      overlap_mode: p.overlap_mode === 'manual' ? 'manual' : 'auto_hook',
      overlap_mm: nonNeg(p.overlap_mm),
      sort_order: pi,
    })
    for (const key of layout.order.filter(k => layout.positions[k].part === p.key)) {
      const posId = newId()
      out.positions.push({
        id: posId, part_id: partId, position_key: key,
        name: String(m.names?.[key] ?? '').trim() || layout.positions[key].name,
        sort_order: layout.order.indexOf(key),
      })
      ;(m.lines[key] || []).forEach((l, li) => {
        const id = lineIds[key][li]
        out.lines.push({
          id, position_id: posId,
          profile_family: String(l.profile_family ?? '').trim(),
          length_rule_type: l.length_rule_type,
          length_deduction_mm: nonNeg(l.length_deduction_mm) ?? 0,
          deduction_auto: l.deduction_auto === true,
          length_factor: isNum(l.length_factor) && l.length_factor > 0 ? l.length_factor : 1,
          quantity_value: nonNeg(l.quantity_value) ?? 1,
          thickness_role: l.thickness_role === 'sash' ? 'sash' : null,
          sort_order: li,
        })
        l.ends.forEach((pair, piece) => pair.forEach((e, end) => {
          const butt = e.mode === 'butt'
          out.ends.push({
            id: newId(), position_profile_id: id, piece_index: piece, end_index: end,
            mode: butt ? 'butt' : 'through',
            butt_to_profile_id: butt && lineExists(m, e.to) ? lineIds[e.to.key][e.to.line] : null,
            deduction_mm: butt ? nonNeg(e.deduction_mm) : null,
          })
        }))
      })
    }
  })
  return out
}

const END_LABEL = ['ปลายที่ 1', 'ปลายที่ 2']

// First reason (Thai) why the model cannot be saved, or null. Covers the DB CHECKs and the contracts SQL cannot:
// a butt target must be a line of this same template (the FK alone allows any template's line), the overlap_mode
// contract (manual needs a non-negative overlap), and the corner rule (exactly one piece runs through per corner).
export function validateModel(model) {
  const layout = model && LAYOUTS[model.layout_kind]
  if (!layout) return 'ไม่รู้จักรูปแบบชิ้นส่วนของเทมเพลตนี้'
  for (const def of layout.parts) {
    const p = (model.parts || []).find(x => x.key === def.key)
    const pname = (p && String(p.name ?? '').trim()) || def.name
    if (!p) return `ไม่พบส่วน ${def.name}`
    if (!(Number.isInteger(Number(p.count)) && Number(p.count) >= 1)) return `${pname}: จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1`
    if (p.overlap_mode !== 'auto_hook' && p.overlap_mode !== 'manual') return `${pname}: เลือกวิธีคิดระยะซ้อน (อัตโนมัติ / กำหนดเอง)`
    if (p.overlap_mode === 'manual' && nonNeg(p.overlap_mm) === null) return `${pname}: กรอกระยะซ้อน (มม.) ตั้งแต่ 0`
    if (p.overlap_mm !== null && p.overlap_mm !== undefined && nonNeg(p.overlap_mm) === null) return `${pname}: ระยะซ้อนต้องไม่ติดลบ`
  }
  for (const key of layout.order) {
    const lines = model.lines?.[key]
    const pos = (String(model.names?.[key] ?? '').trim()) || layout.positions[key].name
    if (!Array.isArray(lines) || !lines.length) return `${pos}: ต้องมีโปรไฟล์อย่างน้อย 1 เส้น`
    const n = pieceCount(model, key)
    for (const [li, l] of lines.entries()) {
      const where = lines.length > 1 ? `${pos} (โปรไฟล์ที่ ${li + 1})` : pos
      if (!String(l.profile_family ?? '').trim()) return `${where}: เลือกกลุ่มโปรไฟล์`
      if (!RULES.has(l.length_rule_type)) return `${where}: เลือกวิธีคิดความยาว`
      if (nonNeg(l.length_deduction_mm) === null) return `${where}: ระยะหักต้องเป็นตัวเลขไม่ติดลบ`
      if (!(isNum(l.length_factor) && l.length_factor > 0)) return `${where}: สัดส่วนของความยาวที่ใช้ต้องมากกว่า 0`
      if (nonNeg(l.quantity_value) === null) return `${where}: จำนวนท่อนต้องเป็นตัวเลขไม่ติดลบ`
      if (l.thickness_role !== null && l.thickness_role !== undefined && l.thickness_role !== 'sash') return `${where}: ความหนาไม่ถูกต้อง`
      for (let piece = 0; piece < n; piece++) {
        for (const end of [0, 1]) {
          const e = l.ends?.[piece]?.[end]
          const at = `${where} ชิ้นที่ ${piece + 1} ${END_LABEL[end]}`
          if (!e || (e.mode !== 'through' && e.mode !== 'butt')) return `${at}: เลือกวิ่งผ่านหรือชน`
          if (e.deduction_mm !== null && e.deduction_mm !== undefined && nonNeg(e.deduction_mm) === null) return `${at}: ระยะหักปลายต้องไม่ติดลบ`
          if (e.mode !== 'butt') continue
          if (e.to) { if (!lineExists(model, e.to)) return `${at}: ชิ้นที่ชนไม่มีอยู่แล้ว เลือกชิ้นที่ชนใหม่` }
          else if (nonNeg(e.deduction_mm) === null) return `${at}: ปลายชนต้องเลือกชิ้นที่ชน หรือกรอกระยะหักปลาย`
        }
      }
    }
  }
  const corner = validateCorners(model)[0]
  if (corner) {
    const pos = (String(model.names?.[corner.key] ?? '').trim()) || layout.positions[corner.key].name
    const why = corner.reason === 'both_through' ? 'วิ่งผ่านทั้งสองชิ้น' : 'ชนทั้งสองชิ้น'
    return `มุมของ ${pos} ชิ้นที่ ${corner.piece + 1} ${END_LABEL[corner.end]}: ${why} (ต้องวิ่งผ่าน 1 ชิ้น ชน 1 ชิ้น)`
  }
  return null
}

// Writes one template's part model: delete its parts (ON DELETE CASCADE removes positions, lines and ends), then
// insert parts -> positions -> lines -> ends, throwing on the first error (no later write is attempted).
// NOT ATOMIC (same accepted tradeoff as the template save in BomTemplates.jsx, which is a chain of separate
// requests): if an insert fails after the delete, the template is left with no / partial part rows until the
// next successful save. The caller must show the error and keep the unsaved model in the editor so the user can
// retry (a retry deletes and rewrites everything); costing reports a partial model as missing profiles, not 0.
export async function saveModel({ supabase, templateId, model }) {
  const problem = validateModel(model)
  if (problem) throw new Error(problem)
  const rows = modelToRows(model, templateId)
  {
    const { error } = await supabase.from(PART_TABLES.parts).delete().eq('template_id', templateId)
    if (error) throw new Error(error.message)
  }
  for (const k of ['parts', 'positions', 'lines', 'ends']) {
    if (!rows[k].length) continue
    const { error } = await supabase.from(PART_TABLES[k]).insert(rows[k])
    if (error) throw new Error(error.message)
  }
}

// Reads ONE template's part rows (parts by template_id, then each child table by its parents' ids) and returns
// its model; null for a template without layout_kind (no query). Throws on a read error, so a failed load can never
// be mistaken for "no rows" and saved over the real data.
export async function loadModel({ supabase, template }) {
  if (!template || !template.layout_kind || !LAYOUTS[template.layout_kind]) return null
  const read = async (table, col, vals) => {
    if (Array.isArray(vals) && !vals.length) return []
    const q = supabase.from(table).select('*')
    const { data, error } = await (Array.isArray(vals) ? q.in(col, vals) : q.eq(col, vals))
    if (error) throw new Error(error.message)
    return data || []
  }
  const parts = await read(PART_TABLES.parts, 'template_id', template.id)
  const positions = await read(PART_TABLES.positions, 'part_id', parts.map(r => r.id))
  const lines = await read(PART_TABLES.lines, 'position_id', positions.map(r => r.id))
  const ends = await read(PART_TABLES.ends, 'position_profile_id', lines.map(r => r.id))
  return modelFromRows({ template, parts, positions, lines, ends })
}
