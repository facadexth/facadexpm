import { describe, it, expect } from 'vitest'
import { calcPoTotals, poLineTotal } from './poTotals.js'

describe('calcPoTotals (moved verbatim from PurchaseOrders.jsx)', () => {
  it('VAT exclusive', () => {
    expect(calcPoTotals([{ line_total: 1000 }], true, false)).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('VAT inclusive backs VAT out', () => {
    expect(calcPoTotals([{ line_total: 1070 }], true, true)).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('no VAT', () => {
    expect(calcPoTotals([{ line_total: 500 }], false, false)).toEqual({ subtotal: 500, vat: 0, total: 500 })
  })
  it('falls back to quantity x price x discount when line_total is missing', () => {
    expect(poLineTotal({ quantity: '2', unit_price: '100', discount_pct: '10' })).toBe(180)
    expect(calcPoTotals([{ quantity: 2, unit_price: 100, discount_pct: 10 }], false, false).subtotal).toBe(180)
  })
})
