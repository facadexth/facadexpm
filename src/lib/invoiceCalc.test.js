import { describe, it, expect } from 'vitest'
import { isCountable, buildUnitSeedRows, waterfall, openQty, drawQty, drawAmount, calcInvoiceTotals } from './invoiceCalc.js'

describe('isCountable', () => {
  it('true for small whole numbers', () => {
    expect(isCountable(5)).toBe(true)
    expect(isCountable(1)).toBe(true)
    expect(isCountable(20)).toBe(true)
  })
  it('false for large or fractional quantities', () => {
    expect(isCountable(21)).toBe(false)
    expect(isCountable(45)).toBe(false)
    expect(isCountable(2.5)).toBe(false)
  })
})

describe('buildUnitSeedRows', () => {
  it('fragments a small whole-number quantity into one row per unit', () => {
    const rows = buildUnitSeedRows({ id: 'qi-1', quantity: 3 })
    expect(rows).toEqual([
      { quotation_item_id: 'qi-1', unit_index: 0, unit_qty: 1 },
      { quotation_item_id: 'qi-1', unit_index: 1, unit_qty: 1 },
      { quotation_item_id: 'qi-1', unit_index: 2, unit_qty: 1 },
    ])
  })
  it('keeps a large or fractional quantity as a single row', () => {
    expect(buildUnitSeedRows({ id: 'qi-2', quantity: 45 })).toEqual([
      { quotation_item_id: 'qi-2', unit_index: 0, unit_qty: 45 },
    ])
    expect(buildUnitSeedRows({ id: 'qi-3', quantity: 2.5 })).toEqual([
      { quotation_item_id: 'qi-3', unit_index: 0, unit_qty: 2.5 },
    ])
  })
})

describe('waterfall', () => {
  it('exact-fills units in order, one at a time', () => {
    const units = [{ unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 2)
    expect(result.map(u => u.target)).toEqual([100, 100, 0])
  })
  it('partially fills the unit where the budget runs out', () => {
    const units = [{ unitQty: 1, cumulativePct: 40 }, { unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 2)
    // finishes unit 0 (needs 0.6 more), fully fills unit 1 (needs 1), leaves 0.4 for unit 2
    expect(result.map(u => u.target)).toEqual([100, 100, 40])
  })
  it('already-complete units are skipped and their target mirrors cumulativePct', () => {
    const units = [{ unitQty: 1, cumulativePct: 100 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 1)
    expect(result.map(u => u.target)).toEqual([100, 100])
  })
  it('a continuous single-row item fills proportionally, not in whole-unit jumps', () => {
    const units = [{ unitQty: 45, cumulativePct: 0 }]
    const result = waterfall(units, 22.5)
    expect(result[0].target).toBe(50)
  })
  it('budget exhausted before all units filled leaves the rest untouched', () => {
    const units = [{ unitQty: 1, cumulativePct: 0 }, { unitQty: 1, cumulativePct: 0 }]
    const result = waterfall(units, 0)
    expect(result.map(u => u.target)).toEqual([0, 0])
  })
})

describe('openQty / drawQty / drawAmount', () => {
  const units = [{ unitQty: 1, cumulativePct: 40, target: 100 }, { unitQty: 1, cumulativePct: 0, target: 0 }]

  it('openQty sums remaining capacity across all units, ignoring target', () => {
    expect(openQty(units)).toBeCloseTo(1.6) // 0.6 remaining on unit 0 + 1 on unit 1
  })
  it('drawQty sums the (target - cumulativePct) delta across all units', () => {
    expect(drawQty(units)).toBeCloseTo(0.6) // only unit 0 has target > cumulativePct here
  })
  it('drawAmount is drawQty times unit price', () => {
    expect(drawAmount(units, 26000)).toBeCloseTo(15600)
  })
})

describe('calcInvoiceTotals', () => {
  const items = [{ line_total: 1000 }]

  it('no VAT', () => {
    expect(calcInvoiceTotals(items, { hasVat: false })).toEqual({ subtotal: 1000, vat: 0, total: 1000 })
  })
  it('VAT added on top', () => {
    expect(calcInvoiceTotals(items, { hasVat: true, priceIncludesVat: false })).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('price already includes VAT, backed out', () => {
    expect(calcInvoiceTotals([{ line_total: 1070 }], { hasVat: true, priceIncludesVat: true })).toEqual({ subtotal: 1000, vat: 70, total: 1070 })
  })
  it('empty items list totals to zero', () => {
    expect(calcInvoiceTotals([], { hasVat: true, priceIncludesVat: false })).toEqual({ subtotal: 0, vat: 0, total: 0 })
  })
})
