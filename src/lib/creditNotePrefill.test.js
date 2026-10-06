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

describe('poItemToCreditLine with base-unit conversion', () => {
  it('aluminium: 10 rods booked as 72 kg, money total unchanged', () => {
    const l = poItemToCreditLine({ inventory_item_id: 'a', description: 'rod', quantity: 10, unit: 'เส้น', unit_price: 720, line_total: 7200 }, { baseQty: 72, baseUnit: 'kg' })
    expect(l).toMatchObject({ quantity: 72, unit: 'kg', unit_price: 100 })
  })
  it('glass area', () => {
    const l = poItemToCreditLine({ inventory_item_id: 'g', description: 'glass', quantity: 4, unit: 'แผ่น', unit_price: 300, line_total: 1200 }, { baseQty: 12, baseUnit: 'm2' })
    expect(l).toMatchObject({ quantity: 12, unit: 'm2', unit_price: 100 })
  })
  it('plain unit factor with discount, no line_total', () => {
    const l = poItemToCreditLine({ inventory_item_id: 'c', description: 'cement', quantity: 2, unit: 'ถุง', unit_price: 500, discount_pct: 10 }, { baseQty: 50, baseUnit: 'kg' })
    expect(l).toMatchObject({ quantity: 50, unit: 'kg', unit_price: 18 })
  })
  it('non-stock line keeps raw quantity/unit', () => {
    const l = poItemToCreditLine({ inventory_item_id: null, description: 'fee', quantity: 3, unit: 'งาน', unit_price: 100, line_total: 300 }, null)
    expect(l).toMatchObject({ quantity: 3, unit: 'งาน', unit_price: 100 })
  })
})

describe('poItemToCreditLine full-return total', () => {
  it('no conversion: qty 3, total 100 -> 100', () => {
    const l = poItemToCreditLine({ inventory_item_id: null, description: 'x', quantity: 3, unit: 'งาน', unit_price: 0, line_total: 100 })
    expect(l.quantity * l.unit_price).toBeCloseTo(100, 8)
  })
})
