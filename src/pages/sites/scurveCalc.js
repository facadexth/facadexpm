// ============================================================
// S-curve calculations — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 7 Step 3):
//   contract_value = 1,000,000
//   leaf "ผลิต" 2026-08-01 -> 2026-08-10 (9-day span), weight 30% -> ramps
//     linearly from 0 (at 08-01) to 300,000 (at 08-10), ~33,333/day
//   leaf "ติดตั้ง" 2026-08-11 -> 2026-08-20 (9-day span), weight 30% ->
//     ramps from 0 (at 08-11, its OWN start) to 300,000 (at 08-20) -- and
//     because these two leaves don't overlap in time, that leaf-local
//     ramp lands on a *combined* series that goes 300,000 -> 600,000 over
//     the same window (leaf "ผลิต" already sits at its completed 300,000
//     throughout, so the sum is 300,000 + [leaf ติดตั้ง's own 0..300,000
//     ramp]). Real sites often have OVERLAPPING phase/subtask spans
//     (e.g. "ผลิต" and "ติดตั้ง" running concurrently for weeks) -- see
//     buildPlanSeries' own doc comment for why each leaf's contribution is
//     computed independently and summed per date, not chained leaf after
//     leaf, so overlapping spans don't corrupt each other's ramp.
//   incomes: 2026-08-05 amount_no_vat=200000 vat=14000 -> actual = 214,000 at that date
//   expenses: 2026-08-01 amount=50000, 2026-08-15 amount=30000 -> cost = 50,000 then 80,000
// ============================================================

/**
 * Cumulative planned billing: ramps LINEARLY across each leaf's own
 * start_date -> end_date span (contract_value * billing_weight_pct% of
 * that leaf, spread evenly over its days) instead of jumping the whole
 * amount at one date. `leaves` is the flattened leaf list from
 * subtaskCalc.js's flattenLeaves() -- a phase with no subtasks is already
 * its own leaf, so a site that never adopts subtasks still ramps across
 * each PHASE's own dates (just smoothly now, instead of jumping at the
 * phase's end_date).
 *
 * A leaf with no start_date/end_date contributes nothing (same as the old
 * `filter((p) => p.end_date)` behavior).
 *
 * IMPORTANT: each leaf's contribution to the total is computed
 * INDEPENDENTLY of every other leaf -- 0 before its own start_date, a
 * linear ramp from 0 to its own totalAmount across its own span, and
 * totalAmount (fully booked) after its own end_date -- and the returned
 * series is the SUM of every leaf's contribution at each date. This
 * matters because leaves routinely overlap in real project data (e.g. a
 * "ผลิต" phase running Mar-Sep and a "ติดตั้ง" phase running Apr-Oct at
 * the same time): a naive sequential model (leaf 2 only starts adding to
 * the running total once leaf 1's full weight has already been booked)
 * produces a bogus near-vertical jump in the plan line wherever two
 * long-running leaves overlap, because it artificially delays leaf 2's
 * contribution until leaf 1 is "done" even though leaf 2's own dates say
 * otherwise. Summing independent per-leaf ramps avoids that.
 *
 * Invariants (see scurveCalc.test.js):
 *   1. The first point of the whole series is
 *      { date: <earliest leaf start_date across all leaves>, value: 0 }
 *      (when leaves don't overlap, this is simply "before anything has
 *      started").
 *   2. At any leaf's own end_date, that leaf's own contribution to the
 *      sum is exactly its full totalAmount (added, not perDay *
 *      totalDays, so it never drifts from float division).
 *   3. Within any leaf's own span, that leaf's own contribution
 *      increases by a constant per-day amount.
 */
export function buildPlanSeries(leaves, contractValue) {
  const dated = leaves.filter((l) => l.start_date && l.end_date)
  if (dated.length === 0) return []

  const parsed = dated.map((l) => {
    const start = new Date(l.start_date)
    const end = new Date(l.end_date)
    return {
      start,
      end,
      startISO: l.start_date,
      endISO: l.end_date,
      totalDays: Math.max(1, Math.round((end - start) / 86400000)),
      totalAmount: ((Number(l.billing_weight_pct) || 0) / 100) * (Number(contractValue) || 0),
    }
  })

  // The date axis is the union of every day covered by any leaf's own
  // span -- this is what gives each leaf's ramp its required day-by-day
  // granularity (a leaf spanning months produces one point per day of
  // its own span, same as before), while still producing ONE merged,
  // date-sorted series across every leaf (overlapping or not).
  const dateSet = new Set()
  parsed.forEach(({ start, totalDays }) => {
    for (let day = 0; day <= totalDays; day++) {
      dateSet.add(new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10))
    }
  })
  const dates = [...dateSet].sort()

  const contributionAt = (dateISO, p) => {
    if (dateISO < p.startISO) return 0
    if (dateISO >= p.endISO) return p.totalAmount
    const day = Math.round((new Date(dateISO) - p.start) / 86400000)
    return (p.totalAmount / p.totalDays) * day
  }

  return dates.map((date) => ({
    date,
    value: Math.round(parsed.reduce((sum, p) => sum + contributionAt(date, p), 0) * 100) / 100,
  }))
}

/** Generic cumulative-sum-by-date series builder. */
function buildCumulativeSeries(rows, dateKey, amountFn) {
  const sorted = rows.slice().sort((a, b) => a[dateKey].localeCompare(b[dateKey]))
  let cumulative = 0
  return sorted.map((r) => {
    cumulative += amountFn(r)
    return { date: r[dateKey], value: cumulative }
  })
}

/** Cumulative actual billing: invoice totals (ex-VAT + VAT) from incomes. */
export function buildActualSeries(incomes) {
  return buildCumulativeSeries(incomes, 'date', (r) => (Number(r.amount_no_vat) || 0) + (Number(r.vat) || 0))
}

/** Cumulative cost: expense amounts. */
export function buildCostSeries(expenses) {
  return buildCumulativeSeries(expenses, 'date', (r) => Number(r.amount) || 0)
}

/**
 * Merges the three cumulative series onto one shared, sorted date axis,
 * forward-filling each series' last known value at every date point so
 * recharts can draw continuous step lines without gaps.
 *
 * "actual" (เบิกจริง) and "cost" (ต้นทุนเรา) are real, already-happened
 * money -- they must never be drawn past today, since there's no real data
 * for the future there (unlike "plan", which is a legitimate projection
 * that's supposed to keep climbing into future phase end-dates). Dates
 * after todayISO get `null` for actual/cost so recharts' default
 * connectNulls={false} simply stops drawing those two lines at today,
 * instead of forward-filling them flat across the whole future range.
 *
 * `extraDates` guarantees a real (forward-filled) data point exists at
 * dates that might otherwise have no transaction/phase-end landing on
 * them -- in particular GanttView's own timeline range.start/range.end,
 * so recharts' <Line> actually starts drawing at the same left edge the
 * Gantt chart's axis does, instead of wherever the first real transaction
 * happens to fall (which can be well inside the domain, leaving an
 * unexplained gap between the axis edge and where the line begins).
 */
export function mergeCumulativeSeries({ plan, actual, cost }, todayISO = new Date().toISOString().slice(0, 10), extraDates = []) {
  const allDates = [...new Set([...plan, ...actual, ...cost].map((p) => p.date).concat(todayISO, extraDates))].sort()

  const forwardFill = (series) => {
    let idx = 0
    let last = 0
    const map = {}
    allDates.forEach((date) => {
      while (idx < series.length && series[idx].date <= date) {
        last = series[idx].value
        idx += 1
      }
      map[date] = last
    })
    return map
  }

  const planMap = forwardFill(plan)
  const actualMap = forwardFill(actual)
  const costMap = forwardFill(cost)

  return allDates.map((date) => ({
    date,
    plan: planMap[date],
    actual: date > todayISO ? null : actualMap[date],
    cost: date > todayISO ? null : costMap[date],
  }))
}
