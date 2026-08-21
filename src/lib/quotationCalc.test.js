import { describe, it, expect } from 'vitest'
import { lineTotal, calcQuotationTotals } from './quotationCalc.js'

describe('lineTotal', () => {
  it('multiplies quantity by unit price', () => {
    expect(lineTotal({ quantity: '3', unit_price: '150.5' })).toBeCloseTo(451.5)
  })
  it('treats missing/blank fields as zero', () => {
    expect(lineTotal({ quantity: '', unit_price: '100' })).toBe(0)
    expect(lineTotal({})).toBe(0)
  })
})

describe('calcQuotationTotals', () => {
  const items = [{ line_total: 1000 }]

  it('no discount, VAT added on top of the raw sum', () => {
    const r = calcQuotationTotals(items, { hasVat: true, priceIncludesVat: false })
    expect(r).toEqual({ rawTotal: 1000, discount: 0, subtotal: 1000, vat: 70, total: 1070 })
  })

  it('flat-amount discount reduces the subtotal before VAT', () => {
    const r = calcQuotationTotals(items, { hasVat: true, priceIncludesVat: false, discountAmount: 100 })
    expect(r).toEqual({ rawTotal: 1000, discount: 100, subtotal: 900, vat: 63, total: 963 })
  })

  it('percent discount, no VAT', () => {
    const r = calcQuotationTotals(items, { hasVat: false, discountPct: 10 })
    expect(r).toEqual({ rawTotal: 1000, discount: 100, subtotal: 900, vat: 0, total: 900 })
  })

  it('price-includes-VAT: discount applies to the VAT-inclusive total, then VAT is backed out', () => {
    const vatInclusiveItems = [{ line_total: 1070 }]
    const r = calcQuotationTotals(vatInclusiveItems, { hasVat: true, priceIncludesVat: true, discountAmount: 107 })
    expect(r).toEqual({ rawTotal: 1070, discount: 107, subtotal: 900, vat: 63, total: 963 })
  })

  it('discount larger than the raw total clamps to zero, not negative', () => {
    const r = calcQuotationTotals(items, { hasVat: false, discountAmount: 5000 })
    expect(r).toEqual({ rawTotal: 1000, discount: 1000, subtotal: 0, vat: 0, total: 0 })
  })

  it('falls back to computing line totals from quantity/unit_price when line_total is absent', () => {
    const r = calcQuotationTotals([{ quantity: '2', unit_price: '500' }], { hasVat: false })
    expect(r.rawTotal).toBe(1000)
  })

  it('empty items list totals to zero', () => {
    const r = calcQuotationTotals([], { hasVat: true, priceIncludesVat: false })
    expect(r).toEqual({ rawTotal: 0, discount: 0, subtotal: 0, vat: 0, total: 0 })
  })
})
