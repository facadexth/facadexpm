import { describe, it, expect } from 'vitest'
import { nextProfitCellState, profitInputValue, isOwnProfit, avgAluPerKg } from './priceStructureTabModel.js'

describe('profit cell model', () => {
  it('shows the saved value, or the draft while typing', () => {
    expect(profitInputValue(20, null)).toBe('20')
    expect(profitInputValue(0, null)).toBe('0')
    expect(profitInputValue(null, null)).toBe('')
    expect(profitInputValue(20, '2')).toBe('2')
  })
  it('derives the value from a refetched item (no stale state)', () => {
    expect(profitInputValue(45, null)).toBe('45')
    expect(profitInputValue(30, null)).toBe('30')
  })
  it('validates a commit', () => {
    expect(nextProfitCellState('-1', 20).action).toBe('error')
    expect(nextProfitCellState('abc', 20).message).toBeTruthy()
    expect(nextProfitCellState('', 20).action).toBe('error')
    expect(nextProfitCellState('20', 20).action).toBe('noop')
    expect(nextProfitCellState('25', 20)).toEqual({ action: 'write', value: 25 })
    expect(nextProfitCellState('0', null)).toEqual({ action: 'write', value: 0 })
  })
  it('isOwnProfit / avgAluPerKg', () => {
    expect(isOwnProfit(0)).toBe(true); expect(isOwnProfit(null)).toBe(false); expect(isOwnProfit('')).toBe(false)
    expect(avgAluPerKg(100, 0)).toBeNull(); expect(avgAluPerKg(100, 4)).toBe(25)
  })
})
