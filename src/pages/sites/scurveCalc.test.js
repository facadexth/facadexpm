import { describe, it, expect } from 'vitest'
import { buildPlanSeries } from './scurveCalc.js'

describe('buildPlanSeries', () => {
  it('ramps linearly across a single leaf\'s own date span instead of jumping at the end', () => {
    const leaves = [{ start_date: '2026-08-01', end_date: '2026-08-11', billing_weight_pct: 30 }]
    const series = buildPlanSeries(leaves, 1000000)
    // 10-day span, 30% of 1,000,000 = 300,000 total -> 30,000/day
    expect(series[0]).toEqual({ date: '2026-08-01', value: 0 })
    expect(series.find((p) => p.date === '2026-08-06').value).toBeCloseTo(150000, -2)
    expect(series[series.length - 1]).toEqual({ date: '2026-08-11', value: 300000 })
  })

  it('accumulates across multiple leaves in date order, each ramping across its own span', () => {
    const leaves = [
      { start_date: '2026-08-01', end_date: '2026-08-10', billing_weight_pct: 30 },
      { start_date: '2026-08-11', end_date: '2026-08-20', billing_weight_pct: 30 },
    ]
    const series = buildPlanSeries(leaves, 1000000)
    expect(series[0]).toEqual({ date: '2026-08-01', value: 0 })
    expect(series.find((p) => p.date === '2026-08-10').value).toBeCloseTo(300000, -2)
    expect(series[series.length - 1]).toEqual({ date: '2026-08-20', value: 600000 })
  })

  it('treats a leaf with no dates as contributing nothing (same as the old "filter((p) => p.end_date)" behavior)', () => {
    const leaves = [{ start_date: null, end_date: null, billing_weight_pct: 30 }]
    expect(buildPlanSeries(leaves, 1000000)).toEqual([])
  })

  it('sums two OVERLAPPING leaves\' independent contributions instead of chaining them sequentially', () => {
    // Leaf A: 2026-08-01..2026-08-10 (9-day span), weight 30% -> 300,000 total.
    // Leaf B: 2026-08-05..2026-08-15 (10-day span), weight 20% -> 200,000 total.
    // These overlap 2026-08-05..2026-08-10 -- a sequential/chained model (leaf B
    // only starts contributing once leaf A's full weight is already booked)
    // would show 300,000 at 08-10 (leaf A just finished, leaf B's chained ramp
    // not yet reflected there); the correct independent-per-leaf-sum model adds
    // leaf A's OWN completed contribution (300,000, since 08-10 is leaf A's own
    // end_date) to leaf B's OWN in-progress contribution at 08-10 (day 5 of its
    // own 10-day span: 200,000/10 * 5 = 100,000), for a total of 400,000.
    const leaves = [
      { start_date: '2026-08-01', end_date: '2026-08-10', billing_weight_pct: 30 },
      { start_date: '2026-08-05', end_date: '2026-08-15', billing_weight_pct: 20 },
    ]
    const series = buildPlanSeries(leaves, 1000000)
    expect(series.find((p) => p.date === '2026-08-10').value).toBeCloseTo(400000, -2)
    // The output must stay date-sorted even though the leaves' own spans
    // overlap and aren't processed as one leaf fully before the next --
    // mergeCumulativeSeries' forward-fill assumes a single ascending pointer.
    expect(series.every((p, i) => i === 0 || p.date > series[i - 1].date)).toBe(true)
  })
})
