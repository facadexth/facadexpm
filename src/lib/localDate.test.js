import { describe, it, expect } from 'vitest'
import { localDateString } from './localDate.js'

describe('localDateString', () => {
  it('uses the local calendar day, zero-padded', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDateString(new Date(2026, 9, 9, 0, 1))).toBe('2026-10-09')
  })
  it('a bad value gives null', () => {
    expect(localDateString(new Date('nope'))).toBeNull()
    expect(localDateString('2026-01-01')).toBeNull()
    expect(localDateString(null)).toBeNull()
  })
})
