// ============================================================
// BOQ cards per phase -- pure helpers for the Kanban, no React/DOM.
// The BOQ quantity limit is per (item, phase): remaining(item, phase) =
// boq_items.planned_qty - Σ phase_tasks.planned_qty of that item in that phase
// (all cards, any status; subtask cards carry the phase_id).
// ============================================================
import { cellNum } from './boqPhaseSplit.js'
import { fmtNum } from './progressCalc.js'

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

/**
 * phase_tasks insert rows for the picked items (same shape as the card form's insert).
 * subtaskId: set when the cards go on a leaf sub-phase (phaseId is then its top phase).
 * A pick may carry its own name; otherwise the card is named after the BOQ line.
 */
export function bulkCardRows({ siteId, phaseId, subtaskId = null, nextSortOrder, zone = null, dueDate = null, picks }) {
  const out = []
  let sort = nextSortOrder
  for (const { item, qty, name } of picks) {
    const q = Number(qty)
    if (!(q > 0)) continue
    out.push({
      site_id: siteId, phase_id: phaseId, subtask_id: subtaskId,
      name: name || item.description, zone, due_date: dueDate, sort_order: sort++,
      status: 'not_started', progress_mode: 'quantity', boq_item_id: item.id, planned_qty: q,
    })
  }
  return out
}

/**
 * The "+ เพิ่มงาน" form, card kind BOQ: draft.boqPicks = [{ boq_item_id, qty }], one card
 * per pick. Returns { picks: [{ item, qty, name }] } or { error } (Thai, names the item).
 * Each qty must be > 0 and <= boqRemaining(item id) (the qty left in this phase). With a
 * single pick the user's typed name is kept; otherwise every card takes its BOQ description.
 */
export function buildBoqMultiSave({ draft, boqItems, boqRemaining = () => null }) {
  const picks = (draft.boqPicks || []).filter((p) => p.boq_item_id)
  if (!picks.length) return { error: 'กรุณาเลือกรายการ BOQ อย่างน้อย 1 รายการ' }
  const typed = (draft.name || '').trim()
  const out = []
  for (const p of picks) {
    const item = (boqItems || []).find((b) => b.id === p.boq_item_id)
    if (!item) return { error: 'ไม่พบรายการ BOQ ที่เลือก' }
    const qty = Number(p.qty)
    if (!(qty > 0)) return { error: `กรุณาใส่จำนวน "${item.description}" (มากกว่า 0)` }
    const left = boqRemaining(item.id)
    if (left != null && qty > left) return { error: `จำนวน "${item.description}" เกินที่เหลือใน BOQ ของเฟสนี้ (${fmtNum(left)})` }
    out.push({ item, qty, name: picks.length === 1 && typed ? typed : item.description })
  }
  return { picks: out }
}
