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
})
