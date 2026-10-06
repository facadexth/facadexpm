import { describe, it, expect } from 'vitest'
import { isPeakAccountCode, isTaxId13, isBranch5 } from './peakFields.js'
describe('peak field validators', () => {
  it('accepts exactly 6 / 13 / 5 digits', () => {
    expect(isPeakAccountCode('530306')).toBe(true)
    expect(isPeakAccountCode('53030')).toBe(false)
    expect(isTaxId13('0105557083391')).toBe(true)
    expect(isTaxId13('010555708339')).toBe(false)
    expect(isBranch5('00000')).toBe(true)
    expect(isBranch5('0')).toBe(false)
  })
  it('rejects blanks and non-digits', () => {
    expect(isPeakAccountCode('')).toBe(false)
    expect(isTaxId13('01055570833ab')).toBe(false)
  })
})
