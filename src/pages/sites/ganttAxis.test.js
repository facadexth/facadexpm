import { describe, it, expect } from 'vitest'
import { computeFocusRange, computeAxisTicks, dateAtPercent } from './ganttTimeline.js'

const r = (a, b) => ({ start: new Date(a), end: new Date(b) })
const iso = (d) => d.toISOString().slice(0, 10)

describe('computeFocusRange', () => {
  it('keeps just the phases (plus padding), not the early deposit dates', () => {
    const f = computeFocusRange(r('2026-09-01', '2026-09-08'), [], '2026-10-04')
    expect(iso(f.start) < '2026-09-01').toBe(true)
    expect(iso(f.start) >= '2026-08-28').toBe(true)
  })
  it('includes subtask dates outside the phase dates', () => {
    const f = computeFocusRange(r('2026-09-01', '2026-09-08'), ['2026-09-20'], null)
    expect(iso(f.end) >= '2026-09-20').toBe(true)
  })
  it('stretches to today when today is near the work, ignores it when far away', () => {
    expect(iso(computeFocusRange(r('2026-09-28', '2026-10-30'), [], '2026-09-20').start) <= '2026-09-20').toBe(true)
    expect(iso(computeFocusRange(r('2026-09-28', '2026-10-30'), [], '2026-03-01').start) >= '2026-09-20').toBe(true)
  })
  it('is null without a base range', () => { expect(computeFocusRange(null)).toBeNull() })
})

describe('computeAxisTicks', () => {
  it('uses every day for a short span', () => {
    const t = computeAxisTicks(r('2026-10-05', '2026-10-12'))
    expect(t.step).toBe(1)
    expect(t.days.length).toBe(8)
  })
  it('uses Mondays for a month or two', () => {
    const t = computeAxisTicks(r('2026-09-28', '2026-10-30'))
    expect(t.step).toBe(3)
    const w = computeAxisTicks(r('2026-08-01', '2026-10-30'))
    expect(w.step).toBe(7)
    expect(w.days.every((d) => d.date.getUTCDay() === 1)).toBe(true)
  })
  it('falls back to months only for a long span', () => {
    const t = computeAxisTicks(r('2026-01-01', '2026-12-31'))
    expect(t.days).toEqual([])
    expect(t.months.length).toBe(12)
  })
  it('pins the starting month at the left edge', () => {
    const t = computeAxisTicks(r('2026-09-12', '2026-10-30'))
    expect(t.months[0].pinned).toBe(true)
    expect(iso(t.months[0].date)).toBe('2026-09-12')
  })
  it('does not pin when the next month starts right away', () => {
    const t = computeAxisTicks(r('2026-09-29', '2026-10-30'))
    expect(t.months[0].pinned).toBeUndefined()
    expect(iso(t.months[0].date)).toBe('2026-10-01')
  })
  it('all tick positions are within 0-100', () => {
    const t = computeAxisTicks(r('2026-09-28', '2026-10-30'))
    for (const d of [...t.days, ...t.months]) { expect(d.x).toBeGreaterThanOrEqual(0); expect(d.x).toBeLessThanOrEqual(100) }
  })
})

describe('dateAtPercent', () => {
  it('maps the ends and the middle to calendar days', () => {
    const range = r('2026-10-01', '2026-10-11')
    expect(iso(dateAtPercent(0, range))).toBe('2026-10-01')
    expect(iso(dateAtPercent(100, range))).toBe('2026-10-11')
    expect(iso(dateAtPercent(50, range))).toBe('2026-10-06')
  })
})

import { expandRangeForTransactions } from './ganttTimeline.js'
describe('expandRangeForTransactions', () => {
  it('ignores dates outside a believable window (typo years)', () => {
    const base = r('2026-09-01', '2026-09-08')
    const out = expandRangeForTransactions(base, ['2026-08-30', '82026-08-30', '1999-01-01'])
    expect(iso(out.start)).toBe('2026-08-30')
    expect(iso(out.end)).toBe('2026-09-08')
  })
})
