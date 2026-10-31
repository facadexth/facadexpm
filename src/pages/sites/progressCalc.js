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
//          parent (has split children; only general cards are split, and
//            general cards have 0 points) -> plain mean of the children;
//          status -> done 1, otherwise 0 ("กำลังทำ" counts 0).
//   node (a phase or a phase_subtasks row):
//          child subtasks -> Σ(billing_weight_pct × child) / Σ billing_weight_pct
//            (plain mean when Σ is 0);
//          else top-level non-issue BOQ cards (progress_mode 'quantity')
//            -> Σ(pts × card) / 100 (general cards in the node are ignored);
//          else top-level non-issue general cards -> 1 when all are done, else 0;
//          else the node's own status: done 1, otherwise 0.
//   BOQ card points come from the database (split by value, sum 100 per node);
//   general cards always have 0 points.
//   site:  % ตามสัญญา over phases that are neither VO nor issue, weighted by
//          billing_weight_pct (plain mean when every weight is 0, 0 when there
//          is no such phase); % รวม VO only with contract value > 0, a VO phase
//          and VO values available (a VO phase with no value counts as 0).
// ============================================================

const isIssueCard = (t) => t.issue_report_id != null

export const round2 = (n) => Math.round(n * 100) / 100
/** Points / quantities for display: 2 dp, no trailing zeros ("12.5", "120"). */
export const fmtNum = (n) => String(round2(Number(n) || 0))

/** Σ(w × p) / Σ w over [w, p] pairs; plain mean when Σ w is 0; null for no pairs. */
export function weightedMean(pairs) {
  if (pairs.length === 0) return null
  const sumW = pairs.reduce((s, [w]) => s + w, 0)
  if (sumW > 0) return pairs.reduce((s, [w, p]) => s + w * p, 0) / sumW
  return pairs.reduce((s, [, p]) => s + p, 0) / pairs.length
}

/** Card progress 0-1. childrenOf(taskId) returns the card's split children.
 *  A split parent is a general card (0 points), so it is the plain mean of its
 *  children -- the SQL task_progress takes the same branch for weight 0. */
export function taskProgress(task, childrenOf) {
  if (task.progress_mode === 'quantity') {
    const planned = Number(task.planned_qty) || 0
    return planned > 0 ? Math.min((Number(task.done_qty) || 0) / planned, 1) : 0
  }
  const kids = childrenOf(task.id) || []
  if (kids.length > 0) return kids.reduce((s, k) => s + taskProgress(k, childrenOf), 0) / kids.length
  return task.status === 'done' ? 1 : 0
}

/** Progress 0-1 from the cards attached directly to one node (all of them:
 *  top-level, split children and issue cards), or null when the node has no
 *  top-level non-issue card -- the caller then falls back to a status.
 *  BOQ cards count by points; with none, the general cards count as one
 *  (all done 1, else 0). */
export function nodeCardsProgress(tasksInNode) {
  const top = tasksInNode.filter((t) => !t.parent_task_id && !isIssueCard(t))
  if (top.length === 0) return null
  const boq = top.filter((t) => t.progress_mode === 'quantity')
  if (boq.length > 0) {
    return boq.reduce((s, t) => s + (Number(t.weight_pts) || 0) * taskProgress(t, () => []), 0) / 100
  }
  return top.every((t) => t.status === 'done') ? 1 : 0
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
