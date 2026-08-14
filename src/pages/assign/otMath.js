// ============================================================
// otMath — pure helpers for OT hour/cost computation, shared by
// the +OT entry form (live preview) and the per-site day cards
// (OT cost line). Formula must match Payroll.jsx/HR.jsx exactly:
// ot_hours × (monthly_salary / 26 / 8) × 1.5
// ============================================================

/** "HH:MM" (or "HH:MM:SS") -> minutes since midnight, or null if unparseable. */
function toMinutes(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

/**
 * Compute OT hours from start/end time-of-day strings, rounded to the
 * nearest 0.5 hour. Returns null if either time is missing/invalid or
 * end is not after start (no overnight OT support).
 */
export function computeOTHours(start, end) {
  const startMin = toMinutes(start)
  const endMin = toMinutes(end)
  if (startMin == null || endMin == null || endMin <= startMin) return null
  const hours = (endMin - startMin) / 60
  return Math.round(hours * 2) / 2
}

/** OT pay for a given monthly salary and OT hours, rounded to 2 decimals. */
export function otCost(monthlySalary, otHours) {
  if (!otHours) return 0
  const hourlyRate = (monthlySalary || 0) / 26 / 8
  return Math.round(hourlyRate * 1.5 * otHours * 100) / 100
}
