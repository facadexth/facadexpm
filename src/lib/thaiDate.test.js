import { describe, it, expect } from 'vitest'
import { formatThaiDate } from './thaiDate.js'

describe('formatThaiDate', () => {
  it('formats YYYY-MM-DD as dd/mm/พ.ศ.', () => {
    expect(formatThaiDate('2026-10-19')).toBe('19/10/2569')
    expect(formatThaiDate('2025-01-01')).toBe('01/01/2568')
  })
  it('slices longer ISO strings without a timezone shift', () => {
    expect(formatThaiDate('2026-12-31T23:30:00Z')).toBe('31/12/2569')
  })
  it('returns — for null, empty or invalid input', () => {
    expect(formatThaiDate(null)).toBe('—')
    expect(formatThaiDate(undefined)).toBe('—')
    expect(formatThaiDate('')).toBe('—')
    expect(formatThaiDate('19/10/2026')).toBe('—')
  })
})
