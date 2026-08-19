import { describe, it, expect } from 'vitest'
import { round2, calcDepositDeduction, remainingBalanceForEdit } from './depositCalc.js'

describe('round2', () => {
  it('rounds to 2 decimal places', () => {
    expect(round2(10.005)).toBeCloseTo(10.01, 2)
    expect(round2(10.001)).toBe(10)
  })
})

describe('calcDepositDeduction', () => {
  it('deducts the full percentage when the balance covers it', () => {
    // 10,000 * 20% = 2,000, remaining balance 5,000 covers it fully
    expect(calcDepositDeduction(10000, 20, 5000)).toBe(2000)
  })

  it('clamps to the remaining balance when the deposit is nearly exhausted', () => {
    // 10,000 * 20% = 2,000 proposed, but only 1,500 remains
    expect(calcDepositDeduction(10000, 20, 1500)).toBe(1500)
  })

  it('returns 0 once the remaining balance is exactly 0', () => {
    expect(calcDepositDeduction(10000, 20, 0)).toBe(0)
  })

  it('returns 0 when depositPct is 0 or falsy (no deposit configured)', () => {
    expect(calcDepositDeduction(10000, 0, 5000)).toBe(0)
    expect(calcDepositDeduction(10000, undefined, 5000)).toBe(0)
  })

  it('returns 0 when noVat is 0 or falsy', () => {
    expect(calcDepositDeduction(0, 20, 5000)).toBe(0)
    expect(calcDepositDeduction(undefined, 20, 5000)).toBe(0)
  })

  it('never goes negative even if remainingBalance is negative (defensive)', () => {
    expect(calcDepositDeduction(10000, 20, -500)).toBe(0)
  })

  it('rounds the result to 2 decimal places', () => {
    // 333.33 * 15% = 49.9995 -> rounds to 50.00
    expect(calcDepositDeduction(333.33, 15, 1000)).toBe(50)
  })
})

describe('remainingBalanceForEdit', () => {
  it('adds the row\'s own prior deduction back onto the current balance', () => {
    // view shows 5,000 remaining AFTER this row already deducted 2,000 --
    // the true balance available when re-editing this row is 7,000
    expect(remainingBalanceForEdit(5000, 2000)).toBe(7000)
  })

  it('returns the balance unchanged for a new row with no prior deduction', () => {
    expect(remainingBalanceForEdit(5000, undefined)).toBe(5000)
    expect(remainingBalanceForEdit(5000, 0)).toBe(5000)
  })

  it('treats a missing site balance as 0', () => {
    expect(remainingBalanceForEdit(undefined, 2000)).toBe(2000)
    expect(remainingBalanceForEdit(null, 2000)).toBe(2000)
  })
})
