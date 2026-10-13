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
//   order     position keys in display order
//   hardware  [{ name, per, qty }]
//   symbol    drawing hints
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
}

export function layoutOf(kind) {
  const def = Object.prototype.hasOwnProperty.call(LAYOUTS, kind) ? LAYOUTS[kind] : null
  if (!def) throw new Error(`unknown_layout: ${kind}`)
  return def
}

export const inputsOf = (kind) => layoutOf(kind).inputs

export const kinds = () => Object.keys(LAYOUTS)

// Coerce one input value to its definition: numbers clamp to min/max (whole numbers rounded), selects must be an option;
// anything invalid falls back to the input's default.
function coerceInput(inp, v) {
  if (inp.type === 'select') return (inp.options || []).some((o) => o.value === v) ? v : inp.default
  if (inp.type === 'number' || inp.min !== undefined || inp.max !== undefined) {
    let n = typeof v === 'number' ? v : Number.NaN
    if (!Number.isFinite(n)) return inp.default
    if (inp.integer) n = Math.round(n)
    if (inp.min !== undefined) n = Math.max(inp.min, n)
    if (inp.max !== undefined) n = Math.min(inp.max, n)
    return n
  }
  return v
}

// Layout input defaults, overridden by the type's layout_params for inputs marked fixed_by_type; clamped to min/max.
export function defaultParams(kind, typeParams) {
  const out = {}
  const tp = typeParams || {}
  for (const inp of inputsOf(kind)) {
    if (inp.default !== undefined) out[inp.key] = coerceInput(inp, inp.default)
    if (inp.fixed_by_type && Object.prototype.hasOwnProperty.call(tp, inp.key)) out[inp.key] = coerceInput(inp, tp[inp.key])
  }
  return out
}

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
  const order = def.order || []
  for (const k of Object.keys(pos)) if (order.filter((x) => x === k).length !== 1) errs.push(`order must list ${k} exactly once`)
  for (const k of order) if (!pos[k]) errs.push(`order lists unknown position ${k}`)
  return errs
}

// The numeric view of model.params that every layout expression is evaluated against:
// numbers pass through, booleans and 'yes'/'no' become 1/0, anything else is left out (so evalExpr throws layout_expr).
export function exprParams(model) {
  const out = {}
  const params = (model && model.params) || {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (v === 'yes') out[k] = 1
    else if (v === 'no') out[k] = 0
  }
  return out
}

// The position each automatic-deduction role reads (rule.auto / rule.overlap 'hook'); a layout may remap any of them
// (e.g. curtain_wall: frame_side -> mullion_outer).
export const DEFAULT_ROLES = Object.freeze({ frame_side: 'frame_side', frame_top: 'frame_top', frame_bottom: 'frame_bottom', mullion: 'mullion', transom: 'transom', hook: 'hook_stile' })
export const rolesOf = (layout) => ({ ...DEFAULT_ROLES, ...((layout && layout.roles) || {}) })

// Test-only: register a throwaway layout definition (e.g. a grid) under its kind.
export function registerLayoutForTest(def) {
  if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') throw new Error('registerLayoutForTest is test-only')
  LAYOUTS[def.kind] = normalize(def)
  return LAYOUTS[def.kind]
}
