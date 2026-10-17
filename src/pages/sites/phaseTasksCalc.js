// ============================================================
// phase_tasks (Kanban card) calculations -- pure functions, no
// React/DOM dependency. A phase's Gantt status becomes derived from
// its own tasks once it has >=1 row (see design spec 2026-09-17).
// Worked example used to hand-verify this file (also covered by
// phaseTasksCalc.test.js):
//   phase "ผลิต" has 5 tasks: 3 done, 1 in_progress, 1 not_started
//   computePhaseTaskStats -> { total: 5, done: 3, pct: 0, derivedStatus: 'in_progress' }
//     (pct is the node % from progressCalc.js: general cards count as one,
//     all done 100 else 0; with BOQ cards it is Σ(weight_pts × card progress) / 100)
//   phase "ติดตั้ง" has 0 tasks -> { total: 0, done: 0, pct: 0, derivedStatus: null }
//     (caller falls back to phase.status, unaffected by this module)
// ============================================================
import { nodeCardsProgress, round2 } from './progressCalc.js'

/** done/total/pct/derivedStatus for one node's tasks. total/done are card
 *  counts; pct is the weighted node % (0-100, 2 dp) from progressCalc.js --
 *  when no top-level non-issue card exists it follows derivedStatus (done
 *  100, otherwise 0). derivedStatus is null when the node has zero tasks --
 *  the caller's cue to fall back to the node's own manually-set status. */
export function computePhaseTaskStats(tasks) {
  const total = tasks.length
  if (total === 0) return { total: 0, done: 0, pct: 0, derivedStatus: null }
  const done = tasks.filter((t) => t.status === 'done').length
  const derivedStatus = done === total
    ? 'done'
    : tasks.some((t) => t.status !== 'not_started') ? 'in_progress' : 'not_started'
  const fromCards = nodeCardsProgress(tasks)
  const pct = fromCards !== null ? round2(fromCards * 100) : (derivedStatus === 'done' ? 100 : 0)
  return { total, done, pct, derivedStatus }
}

/** The phase to show on the Day View's per-site mini task board: the
 *  earliest (by sort_order) phase with tasks that's in_progress, falling
 *  back to the earliest with tasks that's not_started. null if no phase
 *  on this site has any tasks yet (caller skips the section entirely). */
export function pickActivePhase(phases, tasksByPhaseId) {
  const withTasks = [...phases]
    .filter((p) => (tasksByPhaseId[p.id] || []).length > 0)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  const inProgress = withTasks.find((p) => computePhaseTaskStats(tasksByPhaseId[p.id]).derivedStatus === 'in_progress')
  if (inProgress) return inProgress
  return withTasks.find((p) => computePhaseTaskStats(tasksByPhaseId[p.id]).derivedStatus === 'not_started') || null
}

/** A task is overdue when it has a due_date in the past and isn't done
 *  yet -- computed on read, never stored (matches site_phases' own
 *  "no derived overdue column" precedent). */
export function isTaskOverdue(task, todayISO) {
  return !!task.due_date && task.due_date < todayISO && task.status !== 'done'
}

/** Tally phase_tasks by status (+ overdue) across possibly-many sites --
 *  an overall total plus a per-site breakdown, keyed by site_id. Shared
 *  by the cross-site Kanban summary subtab (Sites.jsx) and the portfolio
 *  Gantt view's KPI row (GanttView.jsx), so both agree on the same counts. */
export function summarizeTasks(tasks, todayISO) {
  const empty = () => ({ not_started: 0, in_progress: 0, done: 0, overdue: 0 })
  const bySite = new Map()
  const total = empty()
  for (const t of tasks) {
    const s = bySite.get(t.site_id) || empty()
    if (t.status === 'not_started' || t.status === 'in_progress' || t.status === 'done') {
      s[t.status]++
      total[t.status]++
    }
    if (isTaskOverdue(t, todayISO)) { s.overdue++; total.overdue++ }
    bySite.set(t.site_id, s)
  }
  return { bySite, total }
}
