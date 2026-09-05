import { describe, it, expect } from 'vitest'
import { computeWeightedAverageCost, convertToBaseUnit, computeAluminumWeightKg, computeGlassAreaSqm, estimateSheetCount } from './inventoryCost.js'

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

describe('computeAluminumWeightKg', () => {
  it('rods × length × linear weight', () => {
    expect(computeAluminumWeightKg(20, 6.4, 1.0)).toBeCloseTo(128)
  })
  it('matches the spec example: 1 rod, 6.4m, 1.0 kg/m -> 6.4 kg', () => {
    expect(computeAluminumWeightKg(1, 6.4, 1.0)).toBeCloseTo(6.4)
  })
})

describe('computeGlassAreaSqm', () => {
  it('matches the spec example: 1 sheet, 1.2m x 2.4m -> 2.88 sqm', () => {
    expect(computeGlassAreaSqm(1, 1.2, 2.4)).toBeCloseTo(2.88)
  })
  it('multiple sheets of the same size', () => {
    expect(computeGlassAreaSqm(5, 1.2, 2.4)).toBeCloseTo(14.4)
  })
})

describe('estimateSheetCount', () => {
  it('divides pooled area by the reference sheet size', () => {
    expect(estimateSheetCount(45.5, 2.88)).toBeCloseTo(15.8, 1)
  })
  it('returns null when no reference size is set', () => {
    expect(estimateSheetCount(45.5, null)).toBe(null)
    expect(estimateSheetCount(45.5, 0)).toBe(null)
  })
})
