import { describe, it, expect } from 'vitest'
import { parseAmount, cleanDecimalText, resolveDepositChoice, fullDepositAmount } from './invoiceDeposit.js'

describe('parseAmount / cleanDecimalText', () => {
  it('treats blank, junk and negatives as 0', () => {
    expect(parseAmount('')).toBe(0)
    expect(parseAmount('abc')).toBe(0)
    expect(parseAmount('-5')).toBe(0)
    expect(parseAmount('12.5')).toBe(12.5)
  })
  it('keeps digits and one dot only', () => {
    expect(cleanDecimalText('1,2a3.4.5')).toBe('123.45')
    expect(cleanDecimalText('')).toBe('')
    expect(cleanDecimalText(null)).toBe('')
  })
})

describe('resolveDepositChoice', () => {
  const base = { subtotal: 150000, balance: 78210 }
  it('none deducts nothing', () => {
    expect(resolveDepositChoice({ ...base, mode: 'none', text: '30' }).amount).toBe(0)
  })
  it('pct is a % of this invoice subtotal', () => {
    const r = resolveDepositChoice({ ...base, mode: 'pct', text: '30' })
    expect(r.amount).toBe(45000)
    expect(r.pct).toBe(30)
    expect(r.over).toBe(false)
  })
  it('value is a fixed baht amount', () => {
    const r = resolveDepositChoice({ ...base, mode: 'value', text: '50000' })
    expect(r.amount).toBe(50000)
    expect(r.pct).toBe(33.33)
  })
  it('100% of a partial billing is capped at the remaining deposit, and says so', () => {
    const r = resolveDepositChoice({ ...base, mode: 'pct', text: '100' })
    expect(r.over).toBe(true)
    expect(r.amount).toBe(78210)
    expect(r.pct).toBe(52.14)
    expect(r.cappedText).toBe('52.14')
  })
  it('a value over the balance is capped to the balance', () => {
    const r = resolveDepositChoice({ ...base, mode: 'value', text: '90000' })
    expect(r.over).toBe(true)
    expect(r.amount).toBe(78210)
    expect(r.cappedText).toBe('78210')
  })
  it('the capped % text never re-exceeds the balance (floored)', () => {
    const r = resolveDepositChoice({ subtotal: 30000, balance: 10000, mode: 'pct', text: '99' })
    expect(r.cappedText).toBe('33.33')
    expect(resolveDepositChoice({ subtotal: 30000, balance: 10000, mode: 'pct', text: r.cappedText }).over).toBe(false)
  })
  it('never deducts more than the invoice itself is worth', () => {
    const r = resolveDepositChoice({ subtotal: 50000, balance: 78210, mode: 'value', text: '60000' })
    expect(r.over).toBe(true)
    expect(r.amount).toBe(50000)
    expect(r.pct).toBe(100)
  })
  it('zero balance or zero subtotal gives zero', () => {
    expect(resolveDepositChoice({ subtotal: 1000, balance: 0, mode: 'pct', text: '30' }).amount).toBe(0)
    expect(resolveDepositChoice({ subtotal: 0, balance: 500, mode: 'value', text: '100' }).pct).toBe(0)
  })
})

describe('fullDepositAmount', () => {
  it('takes the whole remaining deposit', () => {
    expect(fullDepositAmount(150000, 78210)).toBe(78210)
  })
  it('never more than the invoice subtotal', () => {
    expect(fullDepositAmount(50000, 78210)).toBe(50000)
  })
})
