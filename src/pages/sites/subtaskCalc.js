// ============================================================
// Recursive Phase/Subtask tree math -- pure functions, no React/DOM
// dependency. Subtasks nest arbitrarily deep (subtask of a subtask, of
// a subtask, ...); a phase's own id and every subtask's own id share one
// flat id-space (both real UUIDs from different tables, never collide),
// so one map keyed by "parent id" -> "direct children" safely serves
// phases and subtasks alike at every depth.
//
// Worked example used to hand-verify this file (also covered by
// subtaskCalc.test.js): phase "ผลิต" (p1) has 2 child subtasks:
// "ตัดวัสดุ" (s1, done, weight 10) and "เชื่อมประกอบ" (s2, weight 20)
// which itself has 1 child subtask "เชื่อมชั้น 3" (s2a, done, weight 20).
//   computeNodeStats('s2', ...) -> derives from s2a (1/1 done) -> done, weight 20
//   computeNodeStats('p1', ...) -> derives from s1+s2 (2/2 done) -> done, weight 30
// ============================================================
import { computePhaseTaskStats } from './phaseTasksCalc.js'

/**
 * Groups subtasks by their direct parent's id: a phase's id maps to its
 * direct-child subtasks (parent_subtask_id null); a subtask's id maps to
 * ITS direct-child subtasks (parent_subtask_id === that subtask's id).
 */
export function groupSubtasksByParent(subtasks) {
  const m = {}
  subtasks.forEach((s) => {
    const key = s.parent_subtask_id || s.phase_id
    ;(m[key] ||= []).push(s)
  })
  return m
}

/** True when a node (identified by id -- a phase or a subtask) has zero
 *  child subtasks, i.e. it's where Kanban microtasks may attach. */
export function isLeaf(nodeId, subtasksByParent) {
  return !(subtasksByParent[nodeId] && subtasksByParent[nodeId].length > 0)
}

/**
 * Recursive status/billing roll-up for one node:
 *   - >=1 child subtask -> derive done/total + derivedStatus from the
 *     children's OWN derived statuses (recursing), and billingWeightPct
 *     = sum of the children's own billingWeightPct-or-manual-weight
 *   - else >=1 microtask -> derive from microtasks via the existing
 *     computePhaseTaskStats (source: 'microtasks'); billingWeightPct
 *     stays null (the node's own manual billing_weight_pct still
 *     applies -- microtasks never carry a weight of their own)
 *   - else -> not derivable; source: 'manual', caller uses the node's
 *     own manual status/billing_weight_pct fields directly
 */
export function computeNodeStats(nodeId, subtasksByParent, microtasksByNodeId) {
  const children = subtasksByParent[nodeId] || []
  if (children.length > 0) {
    const childStats = children.map((c) => {
      const stats = computeNodeStats(c.id, subtasksByParent, microtasksByNodeId)
      const weight = stats.billingWeightPct != null ? stats.billingWeightPct : (Number(c.billing_weight_pct) || 0)
      return { ...stats, weight }
    })
    const total = childStats.length
    const done = childStats.filter((s) => s.derivedStatus === 'done').length
    const derivedStatus = done === total
      ? 'done'
      : childStats.some((s) => s.derivedStatus && s.derivedStatus !== 'not_started') ? 'in_progress' : 'not_started'
    const billingWeightPct = childStats.reduce((sum, s) => sum + s.weight, 0)
    return { total, done, pct: Math.round((done / total) * 100), derivedStatus, billingWeightPct, source: 'subtasks' }
  }
  const microtasks = microtasksByNodeId[nodeId] || []
  if (microtasks.length > 0) {
    const stats = computePhaseTaskStats(microtasks)
    return { ...stats, billingWeightPct: null, source: 'microtasks' }
  }
  return { total: 0, done: 0, pct: 0, derivedStatus: null, billingWeightPct: null, source: 'manual' }
}

/**
 * Every leaf node (phase or subtask with zero child subtasks) across a
 * site's full tree, each still carrying its own dates/billing_weight_pct
 * -- flattened once here so callers (the S-curve) never need to know or
 * care how deep any branch goes.
 */
export function flattenLeaves(phases, subtasksByParent) {
  const leaves = []
  const walk = (node) => {
    const children = subtasksByParent[node.id] || []
    if (children.length === 0) { leaves.push(node); return }
    children.forEach(walk)
  }
  phases.forEach(walk)
  return leaves
}

/**
 * Depth-first list of every row to render: each phase, then (only if its
 * id is in expandedIds) its direct child subtasks, then (only if THAT
 * subtask's id is also in expandedIds) its own children, recursively.
 * depth is for indentation only (0 = phase row).
 */
export function flattenVisibleRows(phases, subtasksByParent, expandedIds) {
  const rows = []
  const walk = (node, depth, isPhase) => {
    rows.push({ node, depth, isPhase })
    if (!expandedIds.has(node.id)) return
    ;(subtasksByParent[node.id] || []).forEach((c) => walk(c, depth + 1, false))
  }
  phases.forEach((p) => walk(p, 0, true))
  return rows
}

/** Sum of billing_weight_pct among a parent's current direct-child
 *  subtasks, excluding one (the subtask being edited, so re-saving it at
 *  its own existing weight doesn't double-count against itself). Used to
 *  hard-block a save that would push the parent's children over 100%. */
export function siblingWeightSum(parentId, subtasksByParent, excludeSubtaskId) {
  const siblings = subtasksByParent[parentId] || []
  return siblings
    .filter((s) => s.id !== excludeSubtaskId)
    .reduce((sum, s) => sum + (Number(s.billing_weight_pct) || 0), 0)
}
