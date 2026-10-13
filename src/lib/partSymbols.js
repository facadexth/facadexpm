// Which drawing symbol a sash piece gets, from the layout's `symbol` entry plus the model's params. Pure.
import { LAYOUTS, exprParams } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'
import { MAX_PART_COUNT } from './partModel.js'

const NONE = { kind: 'none', hinge: null }

// -> { kind: 'v_hinge'|'slide'|'fold'|'none', hinge: 'left'|'right'|'top'|null }
export function symbolFor(model, partKey, pieceIdx = 0) {
  const sym = LAYOUTS[model?.layout_kind]?.symbol
  const kind = sym && Object.prototype.hasOwnProperty.call(sym, partKey) ? sym[partKey] : null
  if (!kind) return NONE
  if (kind !== 'v_hinge') return { kind, hinge: null }
  const hinge = sym.hinge ?? 'left'
  if (hinge !== 'alternate') return { kind, hinge }
  const part = (model.parts || []).find((p) => p.key === partKey)
  let count = 1
  try { count = Math.min(MAX_PART_COUNT, Math.max(1, Math.round(evalExpr(part?.count ?? 1, exprParams(model))))) } catch { count = 1 }
  if (count <= 1) return { kind, hinge: model.params?.hinge === 'right' ? 'right' : 'left' }
  return { kind, hinge: pieceIdx < Math.ceil(count / 2) ? 'left' : 'right' }
}
