// ============================================================
// Pure cell-state derivation for HR's week/month attendance grid
// (spec: 2026-09-29-checkin-locations-design.md, "Week/month attendance
// grid" + Decision 7). No I/O -- AttendanceGrid.jsx fetches
// worker_checkins/worker_assignments once per visible range and calls
// this to decide what each cell shows.
// ============================================================

// Assignment types that count as "this worker was scheduled today" for
// the grid's blank-vs-missed distinction -- mirrors the same set
// perform_worker_checkin_by_id's own existence check uses.
const SCHEDULED_TYPES = ['site', 'factory', 'subcontract']

export function deriveCellStates(checkins, assignments) {
  const key = (workerId, date) => `${workerId}::${date}`

  const checkinByKey = new Map()
  for (const c of checkins) checkinByKey.set(key(c.worker_id, c.date), c)

  const scheduledKeys = new Set()
  for (const a of assignments) {
    if (SCHEDULED_TYPES.includes(a.type)) scheduledKeys.add(key(a.worker_id, a.date))
  }

  return function cellState(workerId, date) {
    const c = checkinByKey.get(key(workerId, date))
    if (c) return c.checkout_at ? 'done' : 'open'
    return scheduledKeys.has(key(workerId, date)) ? 'missed' : null
  }
}
