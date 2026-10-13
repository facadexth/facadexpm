// Pure editor state for the BOM template part editor. No I/O, no React.
//
// Model shape:
// {
//   layout_kind: 'sliding_2' | any kind registered in layoutRegistry.js,
//   parts: [{ key, name, count, overlap_mode, overlap_mm }],
//   lines: { [positionKey]: [ {
//     profile_family, length_rule_type, length_deduction_mm, deduction_auto,
//     length_factor, quantity_value, thickness_role,
//     ends: [ [end0, end1], ... one pair per piece ]   // end = { mode:'through'|'butt'|'mitre', to:{key,line}|null, deduction_mm:number|null }
//   } ] },
//   names: { [positionKey]: name },
//   params: { [inputKey]: value }   // layout inputs (absent on models saved before layouts had inputs)
// }
// Every layout rule (positions, piece counts, line defaults, corners) comes from the layout definition
// (src/lib/layouts/<kind>.js via layoutRegistry.js); nothing here is specific to one layout.
// Corner rule: at every corner exactly one piece runs through and the other butts. Not checked for a part whose corner
// is 'mitre' (its ends are cut 45°, partExpand ignores their stored modes) nor at 'mitre' / 'tee' joints.
// Tee joint (a transom meeting a mullion's side): the vertical runs through; the horizontal's ends default to through
// because the grid rule.auto (grid_cols / grid_rows) already deducts the bars it meets; set to butt it deducts b(vertical).
// rule.type 'sash_width' / 'sash_height' are editor vocabulary: defaultLine stores them as width_minus / height_minus.
// Expression factors (rule.factor a string) are re-derived on line 0 by setParams: an owner's edit of such a factor
// is NOT preserved across a param change (literal factors and extra lines are left alone).
// Line pairing rule: line i of a position pairs ONLY with line i of its corner partner position;
// a partner without line i is free-standing (extra profiles like covers/trims): nothing is flipped, no validation.
// A butt end with to:null is legal only when deduction_mm is set (partExpand reports no_butt_target otherwise).
// All functions are immutable: they return new models and never touch their input.

import { LAYOUTS, defaultParams, exprParams, rolesOf } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'
import { cycleCell } from './layoutCells.js'

export { LAYOUTS }

// Upper bound of a part's count (the drawing and per-piece ends grow with it; a typo like 5000 must not explode the model).
export const MAX_PART_COUNT = 10

const clone = (x) => JSON.parse(JSON.stringify(x))
const layoutOfModel = (model) => LAYOUTS[model.layout_kind]
const posOf = (model, key) => layoutOfModel(model).positions[key]

// A position with `enabled: '<expr>'` exists only while the expression is non-zero over the params (swing_door sill).
const enabledPos = (layout, key, p) => {
  const e = layout.positions[key]?.enabled
  return e === undefined || evalExpr(e, p) !== 0
}
const isEnabled = (model, key) => enabledPos(layoutOfModel(model), key, exprParams(model))

// Joints between present positions only: a joint that names a disabled position is skipped (its ends become joint-less -> through).
function jointsOf(model) {
  const layout = layoutOfModel(model)
  const joints = layout?.joints || []
  if (!joints.some((j) => [j.h, ...j.v].some((k) => layout.positions[k]?.enabled !== undefined))) return joints
  const p = exprParams(model)
  return joints.filter((j) => [j.h, ...j.v].every((k) => enabledPos(layout, k, p)))
}

// layout.validParams: an expression over params that must be > 0, checked BEFORE any rule is evaluated (so no division by 0).
function checkParams(layout, params) {
  if (layout.validParams === undefined) return
  const p = exprParams({ params })
  let ok = false
  try { ok = evalExpr(layout.validParams, p) > 0 } catch { ok = false }
  if (!ok) throw new Error('layout_params_invalid')
}

// Upper bound of pieces of one position per line (largest legitimate: (rows+1)·cols transoms = 9·12 = 108).
export const MAX_PIECES_PER_LINE = 120

const clampInt = (x, max) => (Number.isFinite(x) ? Math.min(max, Math.max(0, Math.round(x))) : 0)

// Expression-driven, so clamped: never negative (cols: 0 -> 'cols-1' = -1), never above MAX_PIECES_PER_LINE.
export function pieceCount(model, key) {
  const pos = posOf(model, key)
  const p = exprParams(model)
  const count = clampInt(evalExpr(model.parts.find((x) => x.key === pos.part)?.count ?? 1, p), MAX_PART_COUNT)
  return clampInt(evalExpr(pos.per, p) * count, MAX_PIECES_PER_LINE)
}

const END = (mode, to = null) => ({ mode, to, deduction_mm: null })

// The joint where the horizontal `key` meets its verticals, or the joint + horizontal end where vertical `key`'s `end` meets one.
const hJoint = (model, key) => jointsOf(model).find((j) => j.h === key) || null
// Pieces of a vertical position per instance of its part (the joint's byEnd stride: 2 for frame sides).
const perOf = (model, key) => Math.max(1, Math.round(evalExpr(posOf(model, key).per, exprParams(model))))
// With `piece` given, a byEnd joint matches vertical piece q only at horizontal end q % perV (horizontal piece floor(q / perV)).
function vJoint(model, key, end, piece = null) {
  for (const j of jointsOf(model)) {
    if (j.vEnd !== end) continue
    const byEnd = j.vPiece === 'byEnd'
    const perV = byEnd && piece !== null ? perOf(model, key) : 1
    for (const hEnd of [0, 1]) {
      if (j.v[hEnd] !== key) continue
      if (piece !== null && byEnd && hEnd !== piece % perV) continue
      return { joint: j, hEnd, hPiece: piece !== null && byEnd ? Math.floor(piece / perV) : piece }
    }
  }
  return null
}

// The position/line a given end butts into by default.
export function defaultTarget(model, key, end) {
  const hj = hJoint(model, key)
  if (hj) return hj.v[end] ? { key: hj.v[end], line: 0 } : null
  const vj = vJoint(model, key, end)
  return vj ? { key: vj.joint.h, line: 0 } : null
}

// Default end of a position: `through` decides who butts at a joint, `mitre` joints mitre both members.
function defaultEnd(model, key, end) {
  const hj = hJoint(model, key)
  const j = hj || vJoint(model, key, end)?.joint
  if (!j) return END('through')
  if (j.mode === 'mitre') return END('mitre')
  if (j.mode === 'tee') return END('through')
  const butts = hj ? j.through === 'v' : j.through === 'h'
  return butts ? END('butt', defaultTarget(model, key, end)) : END('through')
}

const defaultPair = (model, key) => [defaultEnd(model, key, 0), defaultEnd(model, key, 1)]

// Sash references compile to the stored base types (bomEngine knows only width/height/width_minus/height_minus/perimeter).
const RULE_TYPE_ALIAS = { sash_width: 'width_minus', sash_height: 'height_minus' }

// Line 0 defaults of a position, from its rule.
export function defaultLine(model, key) {
  const rule = posOf(model, key).rule || {}
  return {
    profile_family: rule.family ?? '',
    length_rule_type: RULE_TYPE_ALIAS[rule.type] ?? rule.type ?? 'width',
    length_deduction_mm: 0,
    deduction_auto: !!rule.auto,
    length_factor: evalExpr(rule.factor ?? 1, exprParams(model)),
    quantity_value: 1,
    thickness_role: rule.role ?? null,
    ends: [],
  }
}

export function ensureEnds(model) {
  const next = clone(model)
  for (const key of Object.keys(next.lines)) {
    const n = pieceCount(next, key)
    next.lines[key].forEach((line, i) => {
      const ends = line.ends || []
      while (ends.length < n) {
        const src = i > 0 ? next.lines[key][0].ends[ends.length] : null
        ends.push(src ? clone(src) : defaultPair(next, key))
      }
      ends.length = n
      line.ends = ends
    })
  }
  return next
}

export function startModel(kind, params = {}) {
  const layout = LAYOUTS[kind]
  if (!layout) throw new Error(`unknown layout ${kind}`)
  const params0 = { ...defaultParams(kind, {}), ...clone(params || {}) }
  checkParams(layout, params0)
  const model = {
    layout_kind: kind,
    parts: layout.parts.map(({ key, name, count, overlap_mode, overlap_mm }) => ({ key, name, count, overlap_mode, overlap_mm })),
    lines: {},
    names: {},
    params: params0,
  }
  for (const key of layout.order) {
    if (!isEnabled(model, key)) continue
    model.lines[key] = [defaultLine(model, key)]
    model.names[key] = layout.positions[key].name
  }
  // layout.namesWhen { param: { position: name } }: a truthy param renames positions (e.g. sliding_n door)
  for (const [param, names] of Object.entries(layout.namesWhen || {})) if (model.params[param]) Object.assign(model.names, names)
  // layout.familiesWhen { param: { position: family } }: a truthy param sets line 0's family (curtain_wall unitized set)
  for (const [param, fams] of Object.entries(layout.familiesWhen || {})) {
    if (!model.params[param]) continue
    for (const [key, fam] of Object.entries(fams)) if (model.lines[key]?.[0]) model.lines[key][0].profile_family = fam
  }
  return ensureEnds(model)
}

// Cell (r, c) of a cells layout takes its next kind (glass -> awning -> spandrel); piece counts follow, so ends are re-derived.
export function cycleCellKind(model, r, c) {
  return setParams(model, { cells: cycleCell(model, r, c).params.cells })
}

// Layout inputs changed: merge them in, re-derive line 0's factor where rule.factor is an expression, and re-derive the
// per-piece ends (piece counts may follow params).
export function setParams(model, patch) {
  const next = clone(model)
  next.params = { ...(next.params || {}), ...clone(patch || {}) }
  checkParams(layoutOfModel(next), next.params)
  const p = exprParams(next)
  // enabled positions follow their expression: drop the ones now off, (re)create the ones now on
  for (const key of layoutOfModel(next).order) {
    const on = enabledPos(layoutOfModel(next), key, p)
    if (!on && next.lines[key]) { delete next.lines[key]; delete next.names[key] }
    else if (on && !next.lines[key]) {
      next.lines[key] = [defaultLine(next, key)]
      next.names[key] = layoutOfModel(next).positions[key].name
    }
  }
  for (const key of Object.keys(next.lines)) {
    const factor = posOf(next, key)?.rule?.factor
    if (typeof factor === 'string' && next.lines[key][0]) next.lines[key][0].length_factor = evalExpr(factor, p)
  }
  return ensureEnds(next)
}

// The corner partner of one end of one piece (an exact involution), from the layout's joints.
// Horizontal end e -> { key: v[e], piece: byEnd ? e : piece, end: vEnd }; a vertical end is the inverse search
// (null on both sides of a tee joint: no corner there). Legacy form partnerEnd(key, piece, end) resolves against sliding_2.
export function partnerEnd(model, key, piece, end) {
  if (typeof model === 'string') return partnerEnd({ layout_kind: 'sliding_2' }, model, key, piece)
  const hj = hJoint(model, key)
  if (hj) return hj.v[end] && hj.mode !== 'tee' ? { key: hj.v[end], piece: hj.vPiece === 'byEnd' ? piece * perOf(model, hj.v[end]) + end : piece, end: hj.vEnd } : null
  const vj = vJoint(model, key, end, piece)
  if (!vj || vj.joint.mode === 'tee') return null
  return { key: vj.joint.h, piece: vj.hPiece ?? piece, end: vj.hEnd }
}

export function setEndMode(model, key, lineIdx, piece, end, mode) {
  const next = ensureEnds(model)
  const lines = next.lines[key]
  const li = lineIdx
  const target = lines[li]?.ends[piece]?.[end]
  if (!target) return next
  target.mode = mode
  const pt = partnerEnd(model, key, piece, end)
  const pEnd = pt && next.lines[pt.key]?.[li]?.ends[pt.piece]?.[pt.end]
  if (mode === 'through') {
    target.to = null
    target.deduction_mm = null
    if (pEnd) {
      pEnd.mode = 'butt'
      pEnd.to = { key, line: li }
      pEnd.deduction_mm = null
    }
  } else {
    if (!target.to && pEnd) target.to = { key: pt.key, line: li }
    else if (!target.to && !pt) {   // no corner partner (tee): butt into the joint's default target, same line when it has one
      const dt = defaultTarget(model, key, end)
      if (dt) target.to = { key: dt.key, line: next.lines[dt.key]?.[li] ? li : 0 }
    }
    if (pEnd) {
      pEnd.mode = 'through'
      pEnd.to = null
      pEnd.deduction_mm = null
    }
  }
  return next
}

const mitredPart = (model, key) => {
  const layout = layoutOfModel(model)
  return layout.parts.find((p) => p.key === layout.positions[key]?.part)?.corner === 'mitre'
}

export function validateCorners(model) {
  const issues = []
  for (const key of Object.keys(model.lines)) {
    if (mitredPart(model, key)) continue
    const n = pieceCount(model, key)
    model.lines[key].forEach((line, li) => {
      for (let piece = 0; piece < n; piece++) {
        for (const end of [0, 1]) {
          const pt = partnerEnd(model, key, piece, end)   // null at tee joints
          if (pt && mitredPart(model, pt.key)) continue
          const pline = pt && model.lines[pt.key]?.[li]
          const a = line.ends[piece]?.[end]
          const b = pline?.ends[pt.piece]?.[pt.end]
          if (!a || !b) continue
          if (a.mode === 'through' && b.mode === 'through') issues.push({ key, piece, end, line: li, reason: 'both_through' })
          else if (a.mode === 'butt' && b.mode === 'butt') issues.push({ key, piece, end, line: li, reason: 'both_butt' })
        }
      }
    })
  }
  return issues
}

export function addLine(model, key) {
  const next = clone(model)
  next.lines[key].push(clone(next.lines[key][0]))
  return next
}

export function removeLine(model, key, idx) {
  if (model.lines[key].length <= 1) return clone(model)
  const next = clone(model)
  next.lines[key].splice(idx, 1)
  for (const k of Object.keys(next.lines)) {
    for (const line of next.lines[k]) {
      for (const pair of line.ends) {
        for (const e of pair) {
          if (e.to && e.to.key === key) {
            if (e.to.line === idx) e.to = next.lines[key].length ? { key, line: 0 } : null
            else if (e.to.line > idx) e.to = { key, line: e.to.line - 1 }
          }
        }
      }
    }
  }
  return next
}

// Part-count field commit: only a whole number >= 1 changes the model (setPartCount -> ensureEnds trims/extends ends).
// A blank, 0, negative, fractional or non-numeric entry returns the SAME model, so retyping never trims the pieces.
export function commitPartCount(model, partKey, value) {
  const n = typeof value === 'number' ? value : numOrNull(value)
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_PART_COUNT) return model
  if (model.parts.find((p) => p.key === partKey)?.count === n) return model
  return setPartCount(model, partKey, n)
}

export function setPartCount(model, partKey, count) {
  const next = clone(model)
  const n = Math.max(1, Math.floor(Number(count)) || 1)
  if (n > MAX_PART_COUNT) return ensureEnds(next)   // ignored: the count stays as it was
  next.parts.find((p) => p.key === partKey).count = n
  return ensureEnds(next)
}

export function groupsOf(lengthsMm, perPiece = 1) {
  const m = new Map()
  for (const x of lengthsMm) {
    const len = Math.round(x * 10) / 10
    m.set(len, (m.get(len) || 0) + perPiece)
  }
  return [...m.entries()].map(([len, n]) => ({ len, n })).sort((a, b) => b.len - a.len)
}

// ---------------------------------------------------------------- editor state helpers (UI)

// A numeric input's text -> a real Number, or null when blank / not a number. Never a string (validateModel needs numbers).
export function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Selection = { key, line }. Clamps to an existing position/line of the model (first position, line 0 otherwise).
export function clampSelection(model, sel) {
  const layout = model && LAYOUTS[model.layout_kind]
  if (!layout) return { key: null, line: 0 }
  const key = sel && model.lines?.[sel.key] ? sel.key : layout.order.find((k) => model.lines?.[k]) || null
  const n = key ? model.lines[key].length : 0
  const line = sel && sel.key === key && Number.isInteger(sel.line) && sel.line >= 0 && sel.line < n ? sel.line : 0
  return { key, line }
}

export function updateLine(model, key, lineIdx, patch) {
  const next = clone(model)
  const line = next.lines[key]?.[lineIdx]
  if (line) Object.assign(line, clone(patch))
  return next
}

export function updatePart(model, partKey, patch) {
  const next = clone(model)
  const part = next.parts.find((p) => p.key === partKey)
  if (part) Object.assign(part, clone(patch))
  return next
}

export function setPositionName(model, key, name) {
  const next = clone(model)
  next.names = { ...(next.names || {}), [key]: name }
  return next
}

// Patch one end of one piece ({ to } resets the deduction to the target's default; { deduction_mm } overrides it).
export function updateEnd(model, key, lineIdx, piece, end, patch) {
  const next = ensureEnds(model)
  const e = next.lines[key]?.[lineIdx]?.ends[piece]?.[end]
  if (!e) return next
  if ('to' in patch) { e.to = patch.to ? { key: patch.to.key, line: patch.to.line } : null; e.deduction_mm = null }
  if ('deduction_mm' in patch) e.deduction_mm = numOrNull(patch.deduction_mm)
  return next
}

// "+ เพิ่มโปรไฟล์ในตำแหน่งนี้": copy line 0 and select the new line.
export function addLineAndSelect(model, key) {
  const next = addLine(model, key)
  return { model: next, sel: { key, line: next.lines[key].length - 1 } }
}

// Remove a line and select line 0 of the same position (mockup).
export function removeLineAndSelect(model, key, idx) {
  return { model: removeLine(model, key, idx), sel: { key, line: 0 } }
}

// ---------------------------------------------------------------- glass panes

// The glass parts of the model (parts with `glass: true`, no aluminium positions): one entry per piece,
// { part, idx, widthRule, widthMm }. widthRule is what the pane width is made of: the opening less both frame sides
// (roles.frame_side line 0 butt distance), divided over the part's pieces. widthMm is that number when given the opening
// ({ widthMm, buttOf }) and the frame side's family has a butt distance, else null. Pure; frameless walls reuse it.
export function glassParts(model, opening = null) {
  const layout = layoutOfModel(model)
  if (!layout) return []
  const p = exprParams(model)
  const sideKey = rolesOf(layout).frame_side
  const fam = model.lines?.[sideKey]?.[0]?.profile_family
  const raw = opening && fam ? opening.buttOf?.(fam) : null
  const b = raw == null ? Number.NaN : Number(raw)
  const out = []
  for (const part of layout.parts) {
    if (!part.glass) continue
    const count = clampInt(evalExpr(model.parts.find((x) => x.key === part.key)?.count ?? part.count, p), MAX_PART_COUNT)
    for (let idx = 0; idx < count; idx++) {
      const widthMm = opening && Number.isFinite(b) && Number.isFinite(opening.widthMm) ? (opening.widthMm - 2 * b) / count : null
      out.push({ part: part.key, idx, widthRule: { auto: 'frame_sides', divisor: count }, widthMm })
    }
  }
  return out
}

// ---------------------------------------------------------------- per-piece layout metadata (track / fixed / names)

// layout.mirrorWhen { param: value }: when every entry matches, piece i of an array-valued part field / pieceNames reads index count-1-i.
function metaIndex(model, partKey, idx) {
  const mw = layoutOfModel(model)?.mirrorWhen
  if (!mw || !Object.entries(mw).every(([k, v]) => model.params?.[k] === v)) return idx
  const part = model.parts.find((p) => p.key === partKey)
  const n = clampInt(evalExpr(part?.count ?? 1, exprParams(model)), MAX_PART_COUNT)
  return n > 0 ? n - 1 - idx : idx
}

const layoutPartOf = (model, partKey) => layoutOfModel(model)?.parts.find((p) => p.key === partKey)

// Track (1-based) a piece of the part slides on: 'alternate' -> 1,2,1,2..; an array -> per piece; otherwise 1.
export function trackOf(model, partKey, pieceIdx) {
  const t = layoutPartOf(model, partKey)?.track
  if (t === 'alternate') return (pieceIdx % 2) + 1
  if (Array.isArray(t)) return t[metaIndex(model, partKey, pieceIdx)] ?? 1
  return 1
}

// Whether a piece of the part is a fixed (non-sliding) pane: part.fixed is a boolean or an array per piece.
export function isFixedPiece(model, partKey, pieceIdx) {
  const f = layoutPartOf(model, partKey)?.fixed
  if (Array.isArray(f)) return !!f[metaIndex(model, partKey, pieceIdx)]
  return !!f
}

// Display name of one piece of a position: layout.pieceNames, else the position's labels, else name + index, else name.
export function pieceLabel(model, key, pieceIdx) {
  const layout = layoutOfModel(model)
  const pos = layout?.positions[key]
  if (!pos) return ''
  const named = layout.pieceNames?.[key]?.[metaIndex(model, pos.part, pieceIdx)]
  if (named) return named
  if (pos.labels?.[pieceIdx]) return pos.labels[pieceIdx]
  const name = model.names?.[key] || pos.name
  return pieceCount(model, key) > 1 ? `${name} ${pieceIdx + 1}` : name
}
