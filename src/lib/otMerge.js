// ============================================================
// otMerge — folds worker_ot rows into the worker accumulator that
// Payroll.jsx and HR.jsx build from worker_assignments, so a worker's
// monthly OT total counts both the legacy per-shift ot_hours
// (worker_assignments) and the new decoupled worker_ot entries.
//
// Callers key their wmap entries off worker_assignments' leave fields —
// Payroll.jsx and HR.jsx both use { leave_sick, leave_personal, ot_hours }
// (the old singular `leave` field is retained only for historical rows
// that predate the sick/personal split). The fallback entry created below
// (for workers with worker_ot rows but no worker_assignments rows) is a
// superset of every field any caller might read, so it stays safe even if
// a future caller's accumulator shape diverges again.
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
