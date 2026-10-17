// ============================================================
// Weighted Gantt progress -- the JS mirror of the SQL functions
// task_progress / node_progress / site_progress_pct in
// supabase/migrations/2026-10-17-09-gantt-progress-data.sql. Both are
// pinned by the shared cases in progressCalc.fixtures.json.
// Pure functions, no React/DOM. Values stay unrounded internally;
// siteProgress rounds its outputs to 2 dp and the UI rounds for display.
//
// Rules (0-1):
//   card:  quantity -> min(done_qty / planned_qty, 1);
//          parent (has split children) -> Σ(child pts × child) / parent pts,
//            plain mean of the children when the parent has 0 points;
//          status -> done 1, otherwise 0 ("กำลังทำ" counts 0).
//   node (a phase or a phase_subtasks row):
//          child subtasks -> Σ(billing_weight_pct × child) / Σ billing_weight_pct
//            (plain mean when Σ is 0);
//          else top-level non-issue cards -> Σ(pts × card) / 100
//            (unallocated points count as 0);
//          else the node's own status: done 1, otherwise 0.
//   site:  % ตามสัญญา over phases that are neither VO nor issue, weighted by
//          billing_weight_pct (plain mean when every weight is 0, 0 when there
//          is no such phase); % รวม VO only with contract value > 0, a VO phase
//          and VO values available (a VO phase with no value counts as 0).
//
// Old data without weight_pts: cards whose weight_pts is undefined/null
// (test data built before the column existed) share the points left in
// their group equally -- an equal share of 100 within the node when every
// card lacks it. That is the same rule the data migration applies
// (round(100 / n, 2) per card), so old count-based % stay the same.
// ============================================================

const isIssueCard = (t) => t.issue_report_id != null
const hasWeight = (t) => t.weight_pts !== undefined && t.weight_pts !== null

export const round2 = (n) => Math.round(n * 100) / 100
/** Points / quantities for display: 2 dp, no trailing zeros ("12.5", "120"). */
export const fmtNum = (n) => String(round2(Number(n) || 0))

/** Points per card; cards without weight_pts split what is left of `pool` equally. */
function effectiveWeights(cards, pool) {
  const definedSum = cards.reduce((s, c) => s + (hasWeight(c) ? Number(c.weight_pts) || 0 : 0), 0)
  const missing = cards.filter((c) => !hasWeight(c)).length
  const share = missing > 0 ? Math.max(pool - definedSum, 0) / missing : 0
  return cards.map((c) => (hasWeight(c) ? Number(c.weight_pts) || 0 : share))
}

/** Σ(w × p) / Σ w over [w, p] pairs; plain mean when Σ w is 0; null for no pairs. */
export function weightedMean(pairs) {
  if (pairs.length === 0) return null
  const sumW = pairs.reduce((s, [w]) => s + w, 0)
  if (sumW > 0) return pairs.reduce((s, [w, p]) => s + w * p, 0) / sumW
  return pairs.reduce((s, [, p]) => s + p, 0) / pairs.length
}

/** Card progress 0-1. childrenOf(taskId) returns the card's split children. */
export function taskProgress(task, childrenOf) {
  if (task.progress_mode === 'quantity') {
    const planned = Number(task.planned_qty) || 0
    return planned > 0 ? Math.min((Number(task.done_qty) || 0) / planned, 1) : 0
  }
  const kids = childrenOf(task.id) || []
  if (kids.length > 0) {
    const parentPts = hasWeight(task) ? Number(task.weight_pts) || 0 : 0
    const ps = kids.map((k) => taskProgress(k, childrenOf))
    if (parentPts > 0) {
      const ws = effectiveWeights(kids, parentPts)
      return ws.reduce((s, w, i) => s + w * ps[i], 0) / parentPts
    }
    return ps.reduce((s, p) => s + p, 0) / ps.length
  }
  return task.status === 'done' ? 1 : 0
}

/** Progress 0-1 from the cards attached directly to one node (all of them:
 *  top-level, split children and issue cards), or null when the node has no
 *  top-level non-issue card -- the caller then falls back to a status. */
export function nodeCardsProgress(tasksInNode) {
  const top = tasksInNode.filter((t) => !t.parent_task_id && !isIssueCard(t))
  if (top.length === 0) return null
  const byParent = {}
  tasksInNode.forEach((t) => { if (t.parent_task_id) (byParent[t.parent_task_id] ||= []).push(t) })
  const childrenOf = (id) => byParent[id] || []
  const ws = effectiveWeights(top, 100)
  return top.reduce((s, t, i) => s + ws[i] * taskProgress(t, childrenOf), 0) / 100
}

/** Node (phase or subtask) progress 0-1.
 *  tasksByNode: node id -> every card in it (key subtask_id || phase_id);
 *  subtasksByParent: node id -> direct child subtasks; nodeById: id -> row (for status). */
export function nodeProgress(nodeId, { tasksByNode, subtasksByParent, nodeById }) {
  const children = subtasksByParent[nodeId] || []
  if (children.length > 0) {
    return weightedMean(children.map((c) => [
      Number(c.billing_weight_pct) || 0,
      nodeProgress(c.id, { tasksByNode, subtasksByParent, nodeById }),
    ]))
  }
  const fromCards = nodeCardsProgress(tasksByNode[nodeId] || [])
  if (fromCards !== null) return fromCards
  const node = nodeById[nodeId]
  return node && node.status === 'done' ? 1 : 0
}

/** Points of a node not given to any top-level non-issue card (0 when a card
 *  without weight_pts takes the equal share of what is left). */
export function unallocatedPoints(tasksInNode) {
  const top = tasksInNode.filter((t) => !t.parent_task_id && !isIssueCard(t))
  if (top.some((t) => !hasWeight(t))) return 0
  const used = top.reduce((s, t) => s + (Number(t.weight_pts) || 0), 0)
  return Math.max(0, round2(100 - used))
}

/**
 * Site progress for one site's rows.
 *   contractValue: sites.contract_value; pass undefined for roles that cannot
 *     see money (PM rows from pm_sites have none) -> totalPct null.
 *   voValues: optional { phaseId: vo_value } from phase_vo_values (OWNER/ADMIN
 *     only). null = not available -> totalPct null. Left out (undefined) ->
 *     each VO phase's own `vo_value` field is read (fixture shape).
 * Returns { contractPct, totalPct | null, phasePct: { id: 0-100 } } in 2 dp;
 * phasePct covers every phase that is not an issue phase.
 */
export function siteProgress({ phases, subtasks = [], tasks = [], contractValue, voValues }) {
  const tasksByNode = {}
  tasks.forEach((t) => { (tasksByNode[t.subtask_id || t.phase_id] ||= []).push(t) })
  const subtasksByParent = {}
  subtasks.forEach((s) => { (subtasksByParent[s.parent_subtask_id || s.phase_id] ||= []).push(s) })
  const nodeById = {}
  phases.forEach((p) => { nodeById[p.id] = p })
  subtasks.forEach((s) => { nodeById[s.id] = s })
  const ctx = { tasksByNode, subtasksByParent, nodeById }

  const counted = phases.filter((p) => !p.is_issue_phase)
  const progressById = {}
  counted.forEach((p) => { progressById[p.id] = nodeProgress(p.id, ctx) })

  const contractPhases = counted.filter((p) => !p.is_vo)
  const contract = weightedMean(contractPhases.map((p) => [Number(p.billing_weight_pct) || 0, progressById[p.id]])) ?? 0

  const voPhases = counted.filter((p) => p.is_vo)
  const cv = Number(contractValue) || 0
  let totalPct = null
  if (cv > 0 && voPhases.length > 0 && voValues !== null) {
    const valueOf = (p) => Number(voValues ? voValues[p.id] : p.vo_value) || 0
    const voSum = voPhases.reduce((s, p) => s + valueOf(p), 0)
    const voDone = voPhases.reduce((s, p) => s + valueOf(p) * progressById[p.id], 0)
    totalPct = round2(((cv * contract + voDone) / (cv + voSum)) * 100)
  }

  const phasePct = {}
  counted.forEach((p) => { phasePct[p.id] = round2(progressById[p.id] * 100) })
  return { contractPct: round2(contract * 100), totalPct, phasePct }
}
