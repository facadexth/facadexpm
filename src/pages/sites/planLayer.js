// ============================================================
// PLAN layer maths -- pure functions, no React/DOM.
// Used by GanttView (ghost bars, delay tags, "ตาม PLAN vN วันนี้ควรได้ X%")
// and SCurveChart's "งานจริง %" mode. A PLAN version is a frozen snapshot
// in site_plan_items: { level: 'phase'|'subtask'|'task', ref_id,
// parent_ref_id, name, start_date, end_date, weight, is_vo }.
// ============================================================
import { buildPlanSeries, mergeCumulativeSeries } from './scurveCalc.js'
import { groupSubtasksByParent, computeNodeDateRange } from './subtaskCalc.js'

const DAY_MS = 86400000

/** The version shown by default: the latest (plans arrive newest first), or null. */
export const latestPlanId = (plans) => (plans && plans.length ? plans[0].id : null)

/**
 * Plan date range of every phase/subtask in one version, by ref_id. A node
 * with child subtask items gets the span of its descendants (the same rule
 * the Gantt applies to the current tree via computeNodeDateRange), so the
 * current and planned ends compare like with like.
 */
export function planRangesByRef(planItems) {
  const nodes = (planItems || []).filter((i) => i.level === 'phase' || i.level === 'subtask')
    .map((i) => ({ ...i, id: i.ref_id }))
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const byParent = groupSubtasksByParent(nodes
    .filter((n) => n.level === 'subtask')
    .map((n) => ({ ...n, parent_subtask_id: n.parent_ref_id, phase_id: n.parent_ref_id })))
  const ranges = {}
  nodes.forEach((n) => { ranges[n.id] = computeNodeDateRange(n.id, byParent, byId) })
  return ranges
}

/** Current end minus planned end in days -> tag; null when either date is missing. */
export function planDelayTag(currentEnd, planEnd) {
  if (!currentEnd || !planEnd) return null
  const days = Math.round((new Date(currentEnd) - new Date(planEnd)) / DAY_MS)
  if (days > 0) return { text: `ช้า ${days} วัน`, tone: 'late' }
  if (days < 0) return { text: `เร็ว ${-days} วัน`, tone: 'early' }
  return { text: 'ตรงแผน', tone: 'on' }
}

/** Planned % series (0-100) from a version's non-VO phase items, weight = billing_weight_pct. */
export function planPctSeries(planItems) {
  const rows = (planItems || [])
    .filter((i) => i.level === 'phase' && !i.is_vo)
    .map((i) => ({ start_date: i.start_date, end_date: i.end_date, billing_weight_pct: i.weight }))
  return buildPlanSeries(rows, 100)
}

/** Value of a date-sorted series at dateISO: 0 before it starts, the last value after it ends. */
export function planPctAt(series, dateISO) {
  let value = 0
  for (const p of series || []) {
    if (p.date > dateISO) break
    value = p.value
  }
  return value
}

/**
 * Chart rows for the งานจริง % mode: the plan line plus the actual line from
 * daily snapshots (site_progress_daily.contract_pct) with today's live % on
 * today. The actual line is null before the first snapshot (no history) and
 * after today.
 */
export function workSeries({ plan, daily, todayISO, livePct, extraDates = [] }) {
  const actual = (daily || [])
    .filter((r) => r.day && r.day < todayISO && r.contract_pct != null)
    .map((r) => ({ date: r.day, value: Number(r.contract_pct) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  actual.push({ date: todayISO, value: Number(livePct) || 0 })
  const firstActual = actual[0].date
  return mergeCumulativeSeries({ plan: plan || [], actual, cost: [] }, todayISO, extraDates)
    .map(({ date, plan: p, actual: a }) => ({ date, plan: p, actual: date < firstActual ? null : a }))
}
