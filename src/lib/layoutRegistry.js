// Registry of part-editor layout definitions (one file per kind under ./layouts/). Pure: no I/O, no React.
//
// Definition shape (storage shape, see layouts/sliding_2.js):
//   kind      ASCII snake_case kind key
//   inputs    ordered extra inputs [{ key, label, default, estimator?, fixed_by_type? }] (W/H are implicit);
//             `estimator` = shown on the item form, `fixed_by_type` = value comes from door_window_types.layout_params
//   parts     [{ key, name, count, overlap_mode, overlap_mm, corner, track, fixed?, glass? }]
//   positions { [positionKey]: { part, orient:'h'|'v', per, name, labels?, rule:{ type, auto?, factor?, overlap?, role?, family? } } }
//   joints    [{ h, v:[leftKey, rightKey], vPiece:'byEnd'|'same', vEnd:0|1, through:'v'|'h', mode:'butt'|'mitre'|'tee' }]
//   roles     optional { role: positionKey } overrides of DEFAULT_ROLES (the positions rule.auto / rule.overlap read)
//   positions[k].enabled   optional expression over params: 0 -> the position is absent from the model (swing_door sill)
//   validParams  optional expression over params that must be > 0 (folding_door 'nL+nR'), else startModel/setParams
//             throw Error('layout_params_invalid') before any rule is evaluated
//   cells     optional marker: per-cell kinds (layoutCells.js); exprParams then adds cells_awning / cells_spandrel
//   familiesWhen optional { param: { position: family } }: a truthy param sets line 0's family at start (curtain_wall unitized)
//   parts[].panel  infill panel part (no aluminium, no positions): contributes layoutCells.panelCells only
//   order     position keys in display order
//   hardware  [{ name, per, qty }]
//   symbol    drawing hints: { [partKey]: 'v_hinge'|'slide'|'fold', hinge?, direction?, fixedMark? }
//             direction (slide only, partSymbols.symbolFor): 'halves' (default) = left half of the pieces →, right half ←;
//             'toward_fixed' = each sliding piece points at the nearest fixed piece (part.fixed); 'outward' = a single leaf
//             runs toward its open side (params.hinge 'left' → ←, else →), two or more part outward from the middle.
// `per`, `count`, `factor`, `overlapCount` may be expressions (strings) over params — see layoutExpr.js / exprParams().
//
// Registered definitions are normalized copies: each part also gets a derived `positions` array (its position keys
// in `order`), which the editor UI reads.

import sliding_2 from './layouts/sliding_2.js'
import fixed_grid from './layouts/fixed_grid.js'
import awning_grid from './layouts/awning_grid.js'
import casement_n from './layouts/casement_n.js'
import sliding_n from './layouts/sliding_n.js'
import sliding_3track from './layouts/sliding_3track.js'
import sliding_2_fixed_2 from './layouts/sliding_2_fixed_2.js'
import swing_door from './layouts/swing_door.js'
import frameless_door from './layouts/frameless_door.js'
import hanging_door from './layouts/hanging_door.js'
import folding_door from './layouts/folding_door.js'
import curtain_wall from './layouts/curtain_wall.js'
import frameless_wall from './layouts/frameless_wall.js'
import { cellParams } from './layoutCells.js'   // layoutCells imports nothing from here (no cycle)

function normalize(def) {
  const keys = [...(def.order || []), ...Object.keys(def.positions || {}).filter((k) => !(def.order || []).includes(k))]
  return {
    ...def,
    inputs: def.inputs || [],
    joints: def.joints || [],
    parts: (def.parts || []).map((p) => ({ ...p, positions: keys.filter((k) => def.positions[k]?.part === p.key) })),
  }
}

// kind -> normalized definition. A plain object: registerLayoutForTest adds keys to it.
export const LAYOUTS = {
  sliding_2: normalize(sliding_2),
  fixed_grid: normalize(fixed_grid),
  awning_grid: normalize(awning_grid),
  casement_n: normalize(casement_n),
  sliding_n: normalize(sliding_n),
  sliding_3track: normalize(sliding_3track),
  sliding_2_fixed_2: normalize(sliding_2_fixed_2),
  swing_door: normalize(swing_door),
  frameless_door: normalize(frameless_door),
  hanging_door: normalize(hanging_door),
  folding_door: normalize(folding_door),
  curtain_wall: normalize(curtain_wall),
  frameless_wall: normalize(frameless_wall),
}

export function layoutOf(kind) {
  const def = Object.prototype.hasOwnProperty.call(LAYOUTS, kind) ? LAYOUTS[kind] : null
  if (!def) throw new Error(`unknown_layout: ${kind}`)
  return def
}

export const inputsOf = (kind) => layoutOf(kind).inputs

export const kinds = () => Object.keys(LAYOUTS)

// Thai label of each kind (the type form's layout_kind select).
export const layoutLabels = Object.freeze({
  sliding_2: 'บานเลื่อนสวน 2 บาน',
  sliding_n: 'บานเลื่อน n บาน',
  sliding_3track: 'บานเลื่อน 3 ราง',
  sliding_2_fixed_2: 'บานเลื่อน 2 ตาย 2',
  fixed_grid: 'บานติดตาย (ซอยกลาง)',
  awning_grid: 'บานกระทุ้ง (ชั้น × ช่อง)',
  casement_n: 'บานเปิดข้าง',
  swing_door: 'ประตูบานเปิด/สวิง',
  frameless_door: 'ประตูสวิงเปลือย',
  hanging_door: 'ประตูเลื่อนรางแขวน',
  folding_door: 'บานเฟี้ยม',
  curtain_wall: 'Curtain wall',
  frameless_wall: 'ผนังกระจกเปลือย',
})

const INVALID = Symbol('invalid')
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Coerce one input value to its definition, or INVALID. The one coercion behind defaultParams and coerceParams.
// Values may come from JSON columns or form text: numeric strings ("2", "0.5") become numbers, clamped to min/max and
// rounded when integer; booleans accept true/false/1/0 and their strings; a select must be one of its options (a numeric
// option also matches its text); cells must be an object (deep-copied).
function coerceInput(inp, v) {
  if (inp.type === 'cells') return isPlainObject(v) ? JSON.parse(JSON.stringify(v)) : INVALID
  if (inp.type === 'boolean') {
    if (v === true || v === 1 || v === 'true' || v === '1') return true
    if (v === false || v === 0 || v === 'false' || v === '0') return false
    return INVALID
  }
  if (inp.type === 'select') {
    const opt = (inp.options || []).find((o) => o.value === v || (typeof o.value === 'number' && typeof v === 'string' && v.trim() !== '' && Number(v) === o.value))
    return opt ? opt.value : INVALID
  }
  if (inp.type === 'number' || inp.min !== undefined || inp.max !== undefined) {
    let n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN)
    if (!Number.isFinite(n)) return INVALID
    if (inp.integer) n = Math.round(n)
    if (inp.min !== undefined) n = Math.max(inp.min, n)
    if (inp.max !== undefined) n = Math.min(inp.max, n)
    return n
  }
  return v
}

// Stored / typed params (bom_templates / estimation_openings / door_window_types .layout_params, or form state) -> the
// kind's params: known input keys only, each coerced (see coerceInput); an invalid value is dropped so the caller's
// defaults apply. A non-object gives {}. Throws unknown_layout for an unknown kind.
export function coerceParams(kind, params) {
  const out = {}
  const src = isPlainObject(params) ? params : {}
  for (const inp of inputsOf(kind)) {
    if (!Object.prototype.hasOwnProperty.call(src, inp.key)) continue
    const v = coerceInput(inp, src[inp.key])
    if (v !== INVALID) out[inp.key] = v
  }
  return out
}

// Layout input defaults, overridden by the type's layout_params for inputs marked fixed_by_type; clamped to min/max.
export function defaultParams(kind, typeParams) {
  const out = {}
  const tp = coerceParams(kind, typeParams)
  for (const inp of inputsOf(kind)) {
    if (inp.default !== undefined) {
      const v = coerceInput(inp, typeof inp.default === 'object' ? JSON.parse(JSON.stringify(inp.default)) : inp.default)
      out[inp.key] = v === INVALID ? inp.default : v
    }
    if (inp.fixed_by_type && Object.prototype.hasOwnProperty.call(tp, inp.key)) out[inp.key] = tp[inp.key]
  }
  return out
}

export const SLIDE_DIRECTIONS = Object.freeze(['halves', 'toward_fixed', 'outward'])

// Definition check (run for every registered layout in the tests). Returns a list of problem strings ([] = valid).
export function validateLayout(def) {
  const errs = []
  const pos = def.positions || {}
  const partKeys = new Set((def.parts || []).map((p) => p.key))
  for (const [k, p] of Object.entries(pos)) if (!partKeys.has(p.part)) errs.push(`position ${k}: unknown part ${p.part}`)
  const seen = new Set()
  for (const j of def.joints || []) {
    if (pos[j.h]?.orient !== 'h') errs.push(`joint ${j.h}: h must be a horizontal position`)
    ;(j.v || []).forEach((v, e) => { if (pos[v]?.orient !== 'v') errs.push(`joint ${j.h}: v[${e}] ${v} must be a vertical position`) })
    if (j.mode === 'tee') continue   // the vertical side of a tee has no corner
    for (const v of new Set(j.v || [])) {
      const id = `${v}/${j.vEnd}`
      if (seen.has(id)) errs.push(`vertical ${v} end ${j.vEnd} is mapped by more than one joint`)
      seen.add(id)
    }
  }
  const dir = def.symbol?.direction
  if (dir !== undefined && !SLIDE_DIRECTIONS.includes(dir)) errs.push(`symbol.direction ${dir}: must be one of ${SLIDE_DIRECTIONS.join(' | ')}`)
  const order = def.order || []
  for (const p of def.parts || []) {
    if (p.panel && (p.glass || (p.positions || Object.keys(pos).filter((k) => pos[k].part === p.key)).length)) errs.push(`part ${p.key}: a panel part has no positions and is not glass`)
  }
  for (const k of Object.keys(pos)) if (order.filter((x) => x === k).length !== 1) errs.push(`order must list ${k} exactly once`)
  for (const k of order) if (!pos[k]) errs.push(`order lists unknown position ${k}`)
  return errs
}

// The numeric view of model.params that every layout expression is evaluated against:
// numbers pass through, booleans and 'yes'/'no' become 1/0, anything else is left out (so evalExpr throws layout_expr).
export function exprParams(model) {
  const out = {}
  const params = (model && model.params) || {}
  const layout = model && Object.prototype.hasOwnProperty.call(LAYOUTS, model.layout_kind) ? LAYOUTS[model.layout_kind] : null
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (v === 'yes') out[k] = 1
    else if (v === 'no') out[k] = 0
    else if (typeof v === 'string' && layout) {
      // a select whose options are numbers (curtain_wall k) stays numeric even if the UI stored the option as text
      const inp = layout.inputs.find((i) => i.key === k && i.type === 'select')
      const opt = inp && inp.options.find((o) => typeof o.value === 'number' && String(o.value) === v)
      if (opt) out[k] = opt.value
    }
  }
  if (layout && layout.cells) Object.assign(out, cellParams(params))
  return out
}

// The position each automatic-deduction role reads (rule.auto / rule.overlap 'hook'); a layout may remap any of them
// (e.g. curtain_wall: frame_side -> mullion_outer).
export const DEFAULT_ROLES = Object.freeze({ frame_side: 'frame_side', frame_top: 'frame_top', frame_bottom: 'frame_bottom', mullion: 'mullion', transom: 'transom', hook: 'hook_stile', track: 'track_rail', track_top: 'track_top', track_bottom: 'track_bottom', track_side: 'track_side' })
export const rolesOf = (layout) => ({ ...DEFAULT_ROLES, ...((layout && layout.roles) || {}) })

// Test-only: register a throwaway layout definition (e.g. a grid) under its kind.
export function registerLayoutForTest(def) {
  if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') throw new Error('registerLayoutForTest is test-only')
  LAYOUTS[def.kind] = normalize(def)
  return LAYOUTS[def.kind]
}
