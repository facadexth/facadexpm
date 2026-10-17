import { describe, it, expect } from 'vitest'
import { monthRange, weekdayOf, periodLabel, comparePeriod } from './period.js'

describe('monthRange', () => {
  it('includes the last day for 28/29/30/31-day months', () => {
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28', lastDay: 28 })
    expect(monthRange(2028, 2).to).toBe('2028-02-29')
    expect(monthRange(2026, 9).to).toBe('2026-09-30')
    expect(monthRange(2026, 10).to).toBe('2026-10-31')
    expect(monthRange(2026, 12).to).toBe('2026-12-31')
  })
})

describe('weekdayOf', () => {
  it('reads the calendar date, not a UTC instant', () => {
    expect(weekdayOf('2026-10-18')).toBe(0) // Sunday
    expect(weekdayOf('2026-10-17')).toBe(6)
    expect(weekdayOf('2026-11-01')).toBe(0)
  })
})

describe('periodLabel / comparePeriod', () => {
  it('formats a Thai BE range', () => {
    expect(periodLabel(2026, 9)).toBe('1–30 ก.ย. 2569')
  })
  it('orders periods', () => {
    expect(comparePeriod({ year: 2026, month: 9 }, { year: 2026, month: 10 })).toBeLessThan(0)
    expect(comparePeriod({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBeGreaterThan(0)
    expect(comparePeriod({ year: 2026, month: 9 }, { year: 2026, month: 9 })).toBe(0)
  })
})
