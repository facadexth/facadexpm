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
}

export function layoutOf(kind) {
  const def = Object.prototype.hasOwnProperty.call(LAYOUTS, kind) ? LAYOUTS[kind] : null
  if (!def) throw new Error(`unknown_layout: ${kind}`)
  return def
}

export const inputsOf = (kind) => layoutOf(kind).inputs

export const kinds = () => Object.keys(LAYOUTS)

// Layout input defaults, overridden by the type's layout_params for inputs marked fixed_by_type.
export function defaultParams(kind, typeParams) {
  const out = {}
  const tp = typeParams || {}
  for (const inp of inputsOf(kind)) {
    if (inp.default !== undefined) out[inp.key] = inp.default
    if (inp.fixed_by_type && Object.prototype.hasOwnProperty.call(tp, inp.key)) out[inp.key] = tp[inp.key]
  }
  return out
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
