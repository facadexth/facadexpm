// Suggested team leader for a repair appointment (owner 2026-11-25): the worker who led the crew at
// this site on the most days (worker_assignments.is_team_leader). Only a suggestion -- never ticked.
// rows: [{ worker_id, date }] (leader rows at the site); activeIds: workers that can still be booked.
// Returns { workerId, days } or null. A tie goes to the one who led most recently.
export function suggestLeader(rows, activeIds) {
  const active = activeIds ? new Set(activeIds) : null
  const byWorker = new Map()
  for (const r of rows || []) {
    if (!r?.worker_id || !r.date || (active && !active.has(r.worker_id))) continue
    const w = byWorker.get(r.worker_id) || { days: new Set(), last: '' }
    w.days.add(r.date)
    if (r.date > w.last) w.last = r.date
    byWorker.set(r.worker_id, w)
  }
  let best = null
  for (const [workerId, w] of byWorker) {
    const days = w.days.size
    if (!best || days > best.days || (days === best.days && w.last > best.last)) best = { workerId, days, last: w.last }
  }
  return best ? { workerId: best.workerId, days: best.days } : null
}
