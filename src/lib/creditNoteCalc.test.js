import { describe, it, expect } from 'vitest'
import { round2, computeCreditNoteTotals, findStockShortfalls, expenseStatusForSettlement, inferVatFlags } from './creditNoteCalc.js'

describe('computeCreditNoteTotals', () => {
  it('adds VAT on top when prices exclude VAT', () => {
    expect(computeCreditNoteTotals([{ quantity: 2, unit_price: 1000 }]))
      .toEqual({ amount_no_vat: 2000, vat: 140, amount: 2140 })
  })
  it('splits VAT out when prices include VAT', () => {
    expect(computeCreditNoteTotals([{ quantity: 1, unit_price: 2140 }], { priceIncludesVat: true }))
      .toEqual({ amount_no_vat: 2000, vat: 140, amount: 2140 })
  })
  it('has no VAT when VAT is disabled', () => {
    expect(computeCreditNoteTotals([{ quantity: 3, unit_price: 100 }], { vatEnabled: false }))
      .toEqual({ amount_no_vat: 300, vat: 0, amount: 300 })
  })
  it('keeps net + vat = amount after rounding', () => {
    const t = computeCreditNoteTotals([{ quantity: 1, unit_price: 99.99 }], { priceIncludesVat: true })
    expect(round2(t.amount_no_vat + t.vat)).toBe(t.amount)
  })
  it('ignores blank/NaN lines', () => {
    expect(computeCreditNoteTotals([{ quantity: '', unit_price: 5 }, { quantity: 1, unit_price: 10 }], { vatEnabled: false }).amount).toBe(10)
  })
})

describe('findStockShortfalls', () => {
  it('flags lines that exceed on-hand and sums repeated items', () => {
    const lines = [{ inventory_item_id: 'a', quantity: 5 }, { inventory_item_id: 'a', quantity: 6 }, { inventory_item_id: null, quantity: 99 }]
    expect(findStockShortfalls(lines, { a: 10 })).toEqual([{ inventory_item_id: 'a', requested: 11, onHand: 10 }])
  })
  it('treats a missing balance as zero', () => {
    expect(findStockShortfalls([{ inventory_item_id: 'b', quantity: 1 }], {})).toEqual([{ inventory_item_id: 'b', requested: 1, onHand: 0 }])
  })
})

describe('expenseStatusForSettlement', () => {
  it('maps owed to pending and the rest to paid', () => {
    expect(expenseStatusForSettlement('owed')).toBe('pending')
    expect(expenseStatusForSettlement('offset')).toBe('paid')
    expect(expenseStatusForSettlement('refunded')).toBe('paid')
  })
})

describe('inferVatFlags', () => {
  const item = { quantity: 1, unit_price: 2000 }
  it('VAT-exclusive draft', () => {
    expect(inferVatFlags({ vat: 140, amount: 2140, supplier_credit_note_items: [item] })).toEqual({ vatEnabled: true, priceIncludesVat: false })
  })
  it('VAT-inclusive draft', () => {
    expect(inferVatFlags({ vat: 140, amount: 2140, supplier_credit_note_items: [{ quantity: 1, unit_price: 2140 }] })).toEqual({ vatEnabled: true, priceIncludesVat: true })
  })
  it('no-VAT draft', () => {
    expect(inferVatFlags({ vat: 0, amount: 2000, supplier_credit_note_items: [item] })).toEqual({ vatEnabled: false, priceIncludesVat: false })
  })
})
