// ============================================================
// otMerge — folds worker_ot rows into the { worker, leave, ot_hours }
// accumulator that Payroll.jsx and HR.jsx build from worker_assignments,
// so a worker's monthly OT total counts both the legacy per-shift
// ot_hours (worker_assignments) and the new decoupled worker_ot entries.
// ============================================================

/** Mutates and returns wmap: { [worker_id]: { worker, leave, ot_hours } } */
export function mergeWorkerOT(wmap, otRows) {
  ;(otRows || []).forEach(o => {
    const w = o.workers
    if (!w) return
    if (!wmap[o.worker_id]) wmap[o.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
    wmap[o.worker_id].ot_hours += (o.ot_hours || 0)
  })
  return wmap
}
