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

// 'done' outranks 'open' -- a worker can have up to two worker_checkins
// rows per day now (one site-based, one location-based, spec Decision 5's
// dual-reference), so the cell reports whichever is furthest along rather
// than whichever row the fetch happened to return last (final review
// finding: the fetch has no ORDER BY, so "last row wins" was
// nondeterministic once two rows per worker/day became possible).
const RANK = { done: 2, open: 1 }

export function deriveCellStates(checkins, assignments) {
  const key = (workerId, date) => `${workerId}::${date}`

  const bestByKey = new Map()
  for (const c of checkins) {
    const k = key(c.worker_id, c.date)
    const state = c.checkout_at ? 'done' : 'open'
    const existing = bestByKey.get(k)
    if (!existing || RANK[state] > RANK[existing]) bestByKey.set(k, state)
  }

  const scheduledKeys = new Set()
  for (const a of assignments) {
    if (SCHEDULED_TYPES.includes(a.type)) scheduledKeys.add(key(a.worker_id, a.date))
  }

  return function cellState(workerId, date) {
    const best = bestByKey.get(key(workerId, date))
    if (best) return best
    return scheduledKeys.has(key(workerId, date)) ? 'missed' : null
  }
}
