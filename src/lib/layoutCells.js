// Per-cell kinds of a grid layout (curtain_wall) and the frameless wall's joint count. Pure: no I/O, no React.
//
// Dependency direction: layoutRegistry.js (exprParams) -> layoutCells.js. This file imports NOTHING from the registry or
// partModel (that would be a cycle); it reads only model.params { rows, cols, spandrel, cells }. The registry calls
// cellParams() only for layouts that declare `cells` in their definition. partModel.cycleCellKind wraps cycleCell with
// setParams so the per-piece ends are re-derived after a cell changes.
//
// params.cells = { "r,c": 'glass'|'awning'|'spandrel' } (row, column, 0-based). Entries outside rows x cols and entries with
// an unknown kind are ignored (a stale key left by shrinking cols never appears nor crashes). A cell with no entry takes
// its default from params.spandrel: 'top' -> row 0 is spandrel, 'bottom' -> the last row, anything else -> glass.

export const CELL_KINDS = Object.freeze(['glass', 'awning', 'spandrel'])   // D2 cycle order
const MAX_ROWS = 8
const MAX_COLS = 12

const dim = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0)
const gridOf = (params) => ({ rows: dim(params?.rows, MAX_ROWS), cols: dim(params?.cols, MAX_COLS) })

// Kinds of every cell of a params object: { "r,c": kind } for each cell of rows x cols.
export function cellKindsOf(params) {
  const { rows, cols } = gridOf(params)
  const stored = params?.cells && typeof params.cells === 'object' ? params.cells : {}
  const out = {}
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = `${r},${c}`
      const own = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined
      if (CELL_KINDS.includes(own)) out[key] = own
      else if ((params.spandrel === 'top' && r === 0) || (params.spandrel === 'bottom' && r === rows - 1)) out[key] = 'spandrel'
      else out[key] = 'glass'
    }
  }
  return out
}

export const cellKinds = (model) => cellKindsOf(model?.params)

export function countKinds(model) {
  const out = { glass: 0, awning: 0, spandrel: 0 }
  for (const k of Object.values(cellKinds(model))) out[k]++
  return out
}

// The identifiers a layout expression may use for the cell counts (dots are not identifier characters in layoutExpr).
export function cellParams(params) {
  const n = countKinds({ params })
  return { cells_awning: n.awning, cells_spandrel: n.spandrel }
}

// Spandrel (infill panel) cells, row-major: [{ r, c }].
export function panelCells(model) {
  return Object.entries(cellKinds(model)).filter(([, k]) => k === 'spandrel').map(([key]) => {
    const [r, c] = key.split(',').map(Number)
    return { r, c }
  })
}

// New model whose cell (r, c) has the next kind: glass -> awning -> spandrel -> glass. Out-of-grid cells: unchanged copy.
// Only touches params.cells (stale keys are dropped while at it); call partModel.cycleCellKind to also refresh the ends.
export function cycleCell(model, r, c) {
  const next = JSON.parse(JSON.stringify(model))
  const kinds = cellKinds(model)
  const key = `${r},${c}`
  if (!Object.prototype.hasOwnProperty.call(kinds, key)) return next
  const stored = model.params?.cells && typeof model.params.cells === 'object' ? model.params.cells : {}
  const kept = {}
  for (const k of Object.keys(kinds)) if (CELL_KINDS.includes(stored[k])) kept[k] = stored[k]
  kept[key] = CELL_KINDS[(CELL_KINDS.indexOf(kinds[key]) + 1) % CELL_KINDS.length]
  next.params = { ...(next.params || {}), cells: kept }
  return next
}

// frameless_wall: silicone joints between the glass panes = cols - 1 (used by the sealant quantity in costing).
export function jointCount(model) {
  return Math.max(0, gridOf(model?.params).cols - 1)
}
