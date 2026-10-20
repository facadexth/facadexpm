// ============================================================
// BOQ cards per phase -- pure helpers for the Kanban, no React/DOM.
// The BOQ quantity limit is per (item, phase): remaining(item, phase) =
// boq_items.planned_qty - Σ phase_tasks.planned_qty of that item in that phase
// (all cards, any status; subtask cards carry the phase_id).
// ============================================================
import { cellNum } from './boqPhaseSplit.js'

const round4 = (n) => Math.round(n * 10000) / 10000

export function boqRemainingInPhase(item, phaseId, tasks, exceptTaskId = null) {
  if (!item) return null
  const used = (tasks || [])
    .filter((t) => t.boq_item_id === item.id && t.phase_id === phaseId && t.id !== exceptTaskId)
    .reduce((s, t) => s + (Number(t.planned_qty) || 0), 0)
  return round4((Number(item.planned_qty) || 0) - used)
}

/**
 * "+ การ์ดจาก BOQ (n)": the items with pct > 0 in this phase. rows = every such item with
 * its remaining qty in the phase (full = nothing left: shown greyed out); count = rows
 * still open. cells = the site's saved split (null / {} when not in BOQ mode -> nothing).
 */
export function boqCardCandidates({ phaseId, boqItems, cells, tasks }) {
  if (!cells || !Object.keys(cells).length) return { rows: [], count: 0 }
  const rows = []
  for (const item of boqItems || []) {
    if (cellNum(cells[item.id]?.[phaseId]) <= 0) continue
    const remaining = boqRemainingInPhase(item, phaseId, tasks)
    rows.push({ item, remaining, full: remaining <= 0 })
  }
  return { rows, count: rows.filter((r) => !r.full).length }
}

/** phase_tasks insert rows for the picked items (same shape as the card form's insert). */
export function bulkCardRows({ siteId, phaseId, nextSortOrder, picks }) {
  const out = []
  let sort = nextSortOrder
  for (const { item, qty } of picks) {
    const q = Number(qty)
    if (!(q > 0)) continue
    out.push({
      site_id: siteId, phase_id: phaseId, subtask_id: null,
      name: item.description, zone: null, due_date: null, sort_order: sort++,
      status: 'not_started', progress_mode: 'quantity', boq_item_id: item.id, planned_qty: q,
    })
  }
  return out
}
