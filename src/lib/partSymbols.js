// Which drawing symbol a sash piece gets, from the layout's `symbol` entry plus the model's params. Pure.
// Drawing-only metadata (spec G9): costing never reads it.
import { LAYOUTS, exprParams } from './layoutRegistry.js'
import { evalExpr } from './layoutExpr.js'
import { MAX_PART_COUNT, isFixedPiece, sequenceIndex, sequenceOf } from './partModel.js'

const NONE = { kind: 'none', hinge: null }

// Instances of a part (its count over the params, clamped like partModel.pieceCount).
function countOf(model, partKey) {
  const part = (model.parts || []).find((p) => p.key === partKey)
  try { return Math.min(MAX_PART_COUNT, Math.max(0, Math.round(evalExpr(part?.count ?? 1, exprParams(model))))) } catch { return 1 }
}

const intParam = (model, k) => (Number.isFinite(model.params?.[k]) ? Math.max(0, Math.round(model.params[k])) : 0)

// The outside-view symbol, legacy shape { kind, hinge } (the hinge only for v_hinge).
function baseSymbol(model, partKey, pieceIdx) {
  const sym = LAYOUTS[model?.layout_kind]?.symbol
  const kind = sym && Object.prototype.hasOwnProperty.call(sym, partKey) ? sym[partKey] : null
  if (!kind) return NONE
  if (kind !== 'v_hinge') return { kind, hinge: null }
  const hinge = sym.hinge ?? 'left'
  if (hinge !== 'alternate') return { kind, hinge }
  const count = countOf(model, partKey) || 1
  if (count <= 1) return { kind, hinge: model.params?.hinge === 'right' ? 'right' : 'left' }
  return { kind, hinge: pieceIdx < Math.ceil(count / 2) ? 'left' : 'right' }
}

/**
 * Folding door (symbol 'fold'): per leaf { hinge, dir } left to right, the stack arrows and whether there is a split.
 * Leaves 0..nL-1 fold to the left, nL..n-1 to the right. Within each side the V alternates and the first leaf counted
 * from that side's jamb is hinged at the jamb (left side: leaf 0 hinge left; right side: leaf n-1 hinge right).
 * arrows: [{ dir: -1, from: 0, count: nL }, { dir: 1, from: nL, count: nR }] without the empty sides.
 */
export function foldSymbols(model) {
  const nL = intParam(model, 'nL'), nR = intParam(model, 'nR')
  const n = Math.min(MAX_PART_COUNT, nL + nR)
  const leaves = []
  for (let i = 0; i < n; i++) {
    if (i < nL) leaves.push({ hinge: i % 2 === 0 ? 'left' : 'right', dir: -1 })
    else leaves.push({ hinge: (n - 1 - i) % 2 === 0 ? 'right' : 'left', dir: 1 })
  }
  const arrows = [{ dir: -1, from: 0, count: nL }, { dir: 1, from: nL, count: nR }].filter((a) => a.count > 0)
  return { leaves, arrows, split: nL > 0 && nR > 0 }
}

// Slide direction of a sliding piece (outside view), from layout.symbol.direction (layoutRegistry.SLIDE_DIRECTIONS):
//   'halves' (also unknown / missing) -> left half of the pieces +1 (→), right half −1 (←), by piece index;
//   'toward_fixed' -> toward the nearest fixed piece (partModel.isFixedPiece; none fixed -> halves);
//   'outward' -> a single leaf toward its open side (params.hinge 'left' → −1, else +1), several leaves part from the middle.
function halves(pieceIdx, count) {
  return pieceIdx < count / 2 ? 1 : -1
}
// A part of the layout's sequence row (sliding_n / sliding_3track: left / middle / right sash parts) is placed by its index
// in that row (partModel.sequenceOf, mirror-aware) and the row's pieces are the ones counted.
function slideDir(model, partKey, pieceIdx, count) {
  const direction = LAYOUTS[model.layout_kind]?.symbol?.direction
  const seq = sequenceIndex(model, partKey, pieceIdx)
  const row = seq ? sequenceOf(model) : null
  if (seq) { pieceIdx = seq.index; count = seq.total }
  const fixedAt = (i) => (row ? isFixedPiece(model, row[i].part, row[i].idx) : isFixedPiece(model, partKey, i))
  if (direction === 'toward_fixed') {
    const fixed = []
    for (let i = 0; i < count; i++) if (fixedAt(i)) fixed.push(i)
    if (!fixed.length) return halves(pieceIdx, count)
    const near = fixed.reduce((a, b) => (Math.abs(b - pieceIdx) < Math.abs(a - pieceIdx) ? b : a))
    return Math.sign(near - pieceIdx) || 1
  }
  if (direction === 'outward') {
    if (count <= 1) return model.params?.hinge === 'left' ? -1 : 1
    return -halves(pieceIdx, count)
  }
  return halves(pieceIdx, count)
}

/**
 * symbolFor(model, partKey, pieceIdx) -> { kind: 'v_hinge'|'slide'|'fold'|'none', hinge: 'left'|'right'|'top'|null }
 * symbolFor(model, partKey, pieceIdx, { view }) -> the drawing shape (outside-view geometry; the caller mirrors for 'in'):
 *   { kind, hinge, dashed, dir: -1|0|1, fixed, split? }
 *   dashed = the sash opens away from the viewer: view 'out' ? open === 'in' : open === 'out' (params.open, default 'out');
 *   fixed pieces (partModel.isFixedPiece) are kind 'none' with fixed: true (the drawing writes F on their pane).
 */
export function symbolFor(model, partKey, pieceIdx = 0, opts) {
  const base = baseSymbol(model, partKey, pieceIdx)
  if (!opts) return base
  const view = opts.view === 'in' ? 'in' : 'out'
  const open = model?.params?.open === 'in' ? 'in' : 'out'
  const dashed = view === 'out' ? open === 'in' : open === 'out'
  if (!LAYOUTS[model?.layout_kind]) return { ...NONE, dashed: false, dir: 0, fixed: false }
  if (isFixedPiece(model, partKey, pieceIdx)) return { kind: 'none', hinge: null, dashed: false, dir: 0, fixed: true }
  if (base.kind === 'slide') return { kind: 'slide', hinge: null, dashed: false, dir: slideDir(model, partKey, pieceIdx, countOf(model, partKey)), fixed: false }
  if (base.kind === 'fold') {
    const fs = foldSymbols(model)
    const leaf = fs.leaves[pieceIdx] || { hinge: 'left', dir: -1 }
    return { kind: 'fold', hinge: leaf.hinge, dashed, dir: leaf.dir, fixed: false, split: fs.split }
  }
  if (base.kind === 'v_hinge') return { kind: 'v_hinge', hinge: base.hinge, dashed, dir: 0, fixed: false }
  return { kind: 'none', hinge: null, dashed: false, dir: 0, fixed: false }
}
