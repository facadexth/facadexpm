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
    const zones = [...new Set((tasks || []).filter((t) => t.boq_item_id === item.id && t.phase_id === phaseId && t.zone).map((t) => t.zone))]
    rows.push({ item, remaining, full: remaining <= 0, zones })
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

// ---------- แยกตามชั้น (cards per floor) ----------
export const DEFAULT_FLOORS = ['FL.1', 'FL.2', 'FL.3', 'FL.4', 'FL.5', 'FL.6', 'Deck']

/** Split total over n floors: whole numbers when integer, else 2-decimal; remainder on the first floors. */
export function splitEvenly(total, n, integer = true) {
  const t = Number(total) || 0
  if (n <= 0) return []
  if (integer && Number.isInteger(t)) {
    const base = Math.floor(t / n)
    let rest = t - base * n
    return Array.from({ length: n }, () => base + (rest-- > 0 ? 1 : 0))
  }
  const base = Math.floor((t / n) * 100) / 100
  const out = Array.from({ length: n }, () => base)
  out[0] = round4(t - base * (n - 1))
  return out
}

/** Σ of an item's per-floor qty (only the given floors). */
export function floorRowSum(perFloor, floors) {
  return round4((floors || []).reduce((s, f) => s + (Number(perFloor?.[f]) || 0), 0))
}

/**
 * One card per item x floor with qty > 0, zone = floor label, planned_qty = that floor's qty.
 * rows: [{ item, target, perFloor: { label: qty }, skipZones?: [] }]. A floor that already has a
 * card of this item in this phase (skipZones) is not created again.
 * Returns { inserts, errors: [{ itemId, sum, target }] } -- an item whose floor sum differs
 * from its target (qty left in this phase) is an error and blocks create.
 */
export function floorCardRows({ siteId, phaseId, nextSortOrder, floors, rows }) {
  const inserts = []
  const errors = []
  let sort = nextSortOrder
  for (const { item, target, perFloor, skipZones = [] } of rows || []) {
    const sum = floorRowSum(perFloor, floors)
    if (Math.abs(sum - (Number(target) || 0)) > 0.0001) { errors.push({ itemId: item.id, sum, target: Number(target) || 0 }); continue }
    for (const f of floors) {
      const q = Number(perFloor?.[f])
      if (!(q > 0) || skipZones.includes(f)) continue
      inserts.push({
        site_id: siteId, phase_id: phaseId, subtask_id: null, name: item.description, zone: f, due_date: null,
        sort_order: sort++, status: 'not_started', progress_mode: 'quantity', boq_item_id: item.id, planned_qty: q,
      })
    }
  }
  return { inserts, errors }
}

/** Floor labels in display order: FL.n numerically, then the rest by name. */
export function sortZones(zones) {
  const rank = (z) => (/\d/.test(z) ? 0 : 1)
  return [...zones].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b), undefined, { numeric: true }))
}
