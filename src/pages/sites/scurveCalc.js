// ============================================================
// S-curve calculations — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 7 Step 4):
//   contract_value = 1,000,000
//   phase "ผลิต" end_date 2026-08-10, weight 30% -> plan jumps to 300,000
//   phase "ติดตั้ง" end_date 2026-08-20, weight 30% -> plan jumps to 600,000
//   incomes: 2026-08-05 amount_no_vat=200000 vat=14000 -> actual = 214,000 at that date
//   expenses: 2026-08-01 amount=50000, 2026-08-15 amount=30000 -> cost = 50,000 then 80,000
// ============================================================

/** Cumulative planned billing: jumps by billing_weight_pct% of contract_value at each phase's end_date. */
export function buildPlanSeries(phases, contractValue) {
  const withEndDate = phases
    .filter((p) => p.end_date)
    .slice()
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  let cumulative = 0
  return withEndDate.map((p) => {
    cumulative += ((Number(p.billing_weight_pct) || 0) / 100) * (Number(contractValue) || 0)
    return { date: p.end_date, value: cumulative }
  })
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
 */
export function mergeCumulativeSeries({ plan, actual, cost }) {
  const allDates = [...new Set([...plan, ...actual, ...cost].map((p) => p.date))].sort()

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
    actual: actualMap[date],
    cost: costMap[date],
  }))
}
