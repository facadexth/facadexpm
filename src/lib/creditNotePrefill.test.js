import { describe, it, expect } from 'vitest'
import { setCreditNotePrefill, peekCreditNotePrefill, clearCreditNotePrefill, poItemToCreditLine } from './creditNotePrefill.js'

describe('creditNotePrefill holder', () => {
  it('peek is idempotent until cleared', () => {
    setCreditNotePrefill({ po_id: 'p1' })
    expect(peekCreditNotePrefill()).toEqual({ po_id: 'p1' })
    expect(peekCreditNotePrefill()).toEqual({ po_id: 'p1' })
    clearCreditNotePrefill()
    expect(peekCreditNotePrefill()).toBeNull()
  })
})

describe('poItemToCreditLine', () => {
  const base = { inventory_item_id: 'i1', description: 'x', unit: 'ea' }
  it('uses line_total / quantity when available', () => {
    expect(poItemToCreditLine({ ...base, quantity: 4, unit_price: 100, discount_pct: 10, line_total: 360 }).unit_price).toBe(90)
  })
  it('applies discount_pct without line_total', () => {
    expect(poItemToCreditLine({ ...base, quantity: 2, unit_price: 100, discount_pct: 10 }).unit_price).toBe(90)
  })
  it('no discount keeps unit_price', () => {
    expect(poItemToCreditLine({ ...base, quantity: 2, unit_price: 100 }).unit_price).toBe(100)
  })
  it('zero or NaN quantity falls back to discount formula', () => {
    expect(poItemToCreditLine({ ...base, quantity: 0, unit_price: 100, discount_pct: 10, line_total: 0 }).unit_price).toBe(90)
    expect(poItemToCreditLine({ ...base, quantity: 'abc', unit_price: 50, line_total: 10 }).unit_price).toBe(50)
  })
})
