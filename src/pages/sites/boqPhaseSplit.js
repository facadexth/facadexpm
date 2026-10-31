// ============================================================
// BOQ % per phase -- pure helpers for the BOQ tab matrix, no React/DOM.
// cells = { [boqItemId]: { [phaseId]: pct } } (a cell may hold the raw input
// string while the user types). computePhaseWeights() is the JS twin of the
// DB function recompute_site_phase_weights(): keep the two in step.
// ============================================================

const round2 = (n) => Math.round(n * 100) / 100
export const cellNum = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

/** Saved rows -> cells; every item x phase present, a missing cell is 0. */
export function cellsFromRows(items, phases, rows) {
  const cells = {}
  for (const it of items) {
    cells[it.id] = {}
    for (const p of phases) cells[it.id][p.id] = 0
  }
  for (const r of rows || []) {
    if (cells[r.boq_item_id] && r.phase_id in cells[r.boq_item_id]) cells[r.boq_item_id][r.phase_id] = cellNum(r.pct)
  }
  return cells
}

/** Template defaults from rpc boq_phase_split_defaults -> cells (same row for every item). */
export function buildDefaultCells(items, phases, defaults) {
  const byPhase = Object.fromEntries((defaults || []).map((d) => [d.phase_id, cellNum(d.pct)]))
  const cells = {}
  for (const it of items) {
    cells[it.id] = {}
    for (const p of phases) cells[it.id][p.id] = byPhase[p.id] ?? 0
  }
  return cells
}

/** Cells -> the p_rows array for save_boq_phase_splits (every cell shown). */
export function cellsToRows(cells, items, phases) {
  const rows = []
  for (const it of items) {
    for (const p of phases) rows.push({ boq_item_id: it.id, phase_id: p.id, pct: cellNum(cells[it.id]?.[p.id]) })
  }
  return rows
}

export const rowTotal = (row) => round2(Object.values(row || {}).reduce((s, v) => s + cellNum(v), 0))
/** The DB accepts 100 +- 0.01 per item. */
export const rowOk = (row) => Math.abs(rowTotal(row) - 100) <= 0.01

/** A cell that differs from the template default (yellow + "แก้เอง"). */
export const cellIsCustom = (value, dflt) => cellNum(value) !== cellNum(dflt)

/** { itemId: share 0..1 } from the BOQ tab's boq_value_shares percentages; equal when unavailable. */
export function itemShares(items, sharesPct) {
  const out = {}
  if (!items.length) return out
  if (sharesPct) {
    for (const it of items) out[it.id] = (Number(sharesPct[it.id]) || 0) / 100
    return out
  }
  for (const it of items) out[it.id] = 1 / items.length
  return out
}

/**
 * Phase weights the DB will derive from these cells: raw(p) = Σ_i share_i x pct(i,p) over
 * contract phases (not VO, not issue), scaled to 100 (equal shares when every raw is 0),
 * 2 dp with the rounding remainder on the largest raw (ties: lowest sort_order). VO -> 0.
 * Issue phases are not in the result.
 */
export function computePhaseWeights({ phases, shares, cells }) {
  const visible = phases.filter((p) => !p.is_issue_phase)
  const contract = visible.filter((p) => !p.is_vo)
  const raw = contract.map((p, idx) => {
    let s = 0
    for (const itemId of Object.keys(cells || {})) s += (shares[itemId] || 0) * cellNum(cells[itemId]?.[p.id])
    return { id: p.id, idx, raw: s }
  })
  const total = raw.reduce((s, r) => s + r.raw, 0)
  const scaled = raw.map((r) => ({ ...r, w: total > 0 ? 100 * r.raw / total : (contract.length ? 100 / contract.length : 0) }))
  const order = scaled.slice().sort((a, b) => b.w - a.w || a.idx - b.idx)
  const rounded = Object.fromEntries(scaled.map((r) => [r.id, round2(r.w)]))
  const sum = round2(Object.values(rounded).reduce((s, x) => s + x, 0))
  if (order.length) rounded[order[0].id] = round2(rounded[order[0].id] + 100 - sum)
  const out = {}
  for (const p of visible) out[p.id] = p.is_vo ? 0 : rounded[p.id]
  return out
}
