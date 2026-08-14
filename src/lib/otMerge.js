// ============================================================
// otMerge — folds worker_ot rows into the worker accumulator that
// Payroll.jsx and HR.jsx build from worker_assignments, so a worker's
// monthly OT total counts both the legacy per-shift ot_hours
// (worker_assignments) and the new decoupled worker_ot entries.
//
// Callers' wmap entries may use the legacy shape { leave, ot_hours }
// (HR.jsx, pre leave-split) or the newer shape
// { leave_sick, leave_personal, ot_hours } (Payroll.jsx, post leave-split).
// During the transition, some callers may carry both. The fallback entry
// created below (for workers with worker_ot rows but no worker_assignments
// rows) includes all of these fields so it's a safe superset regardless of
// which shape the caller uses — each caller only reads the fields it cares
// about, so the extra unused fields are harmless.
// ============================================================

/**
 * Mutates and returns wmap: { [worker_id]: { worker, leave, leave_sick,
 * leave_personal, ot_hours, ... } } — the fallback entry created here is a
 * superset covering both the legacy `leave` field and the newer
 * `leave_sick`/`leave_personal` fields.
 */
export function mergeWorkerOT(wmap, otRows) {
  ;(otRows || []).forEach(o => {
    const w = o.workers
    if (!w) return
    if (!wmap[o.worker_id]) wmap[o.worker_id] = { worker: w, leave: 0, leave_sick: 0, leave_personal: 0, ot_hours: 0 }
    wmap[o.worker_id].ot_hours += (o.ot_hours || 0)
  })
  return wmap
}
