// ============================================================
// phase_tasks (Kanban card) calculations -- pure functions, no
// React/DOM dependency. A phase's Gantt status becomes derived from
// its own tasks once it has >=1 row (see design spec 2026-09-17).
// Worked example used to hand-verify this file (also covered by
// phaseTasksCalc.test.js):
//   phase "ผลิต" has 5 tasks: 3 done, 1 in_progress, 1 not_started
//   computePhaseTaskStats -> { total: 5, done: 3, pct: 60, derivedStatus: 'in_progress' }
//   phase "ติดตั้ง" has 0 tasks -> { total: 0, done: 0, pct: 0, derivedStatus: null }
//     (caller falls back to phase.status, unaffected by this module)
// ============================================================

/** done/total/pct/derivedStatus for one phase's tasks. derivedStatus is
 *  null when the phase has zero tasks -- the caller's cue to fall back
 *  to the phase's own manually-set status instead. */
export function computePhaseTaskStats(tasks) {
  const total = tasks.length
  if (total === 0) return { total: 0, done: 0, pct: 0, derivedStatus: null }
  const done = tasks.filter((t) => t.status === 'done').length
  const derivedStatus = done === total
    ? 'done'
    : tasks.some((t) => t.status !== 'not_started') ? 'in_progress' : 'not_started'
  return { total, done, pct: Math.round((done / total) * 100), derivedStatus }
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
