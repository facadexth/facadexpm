import { describe, it, expect } from 'vitest'
import { computeWeightedAverageCost, convertToBaseUnit } from './inventoryCost.js'

describe('computeWeightedAverageCost', () => {
  it('first receipt into an empty balance', () => {
    expect(computeWeightedAverageCost(0, 0, 100, 50)).toBe(50)
  })
  it('blends a second receipt at a different cost', () => {
    expect(computeWeightedAverageCost(100, 50, 100, 70)).toBe(60)
  })
  it('zero-cost leftover transfer pulls the average down (decision #6)', () => {
    expect(computeWeightedAverageCost(50, 100, 50, 0)).toBe(50)
  })
  it('unequal quantities weight correctly', () => {
    expect(computeWeightedAverageCost(10, 100, 90, 10)).toBe(19)
  })
})

describe('convertToBaseUnit', () => {
  it('applies a fixed conversion factor (aluminium: 1 piece = 2.3 kg)', () => {
    expect(convertToBaseUnit(5, 2.3)).toBeCloseTo(11.5)
  })
  it('factor of 1 is a no-op', () => {
    expect(convertToBaseUnit(42, 1)).toBe(42)
  })
})
