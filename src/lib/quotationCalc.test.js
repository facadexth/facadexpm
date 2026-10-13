import { describe, it, expect } from 'vitest'
import { lineTotal, calcQuotationTotals, sumMaterialLabor, normalizeSnapshotItems } from './quotationCalc.js'

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

describe('sumMaterialLabor', () => {
  it('sums material and labor separately across item lines', () => {
    const items = [
      { quantity: '2', unit_price_material: '100', unit_price_labor: '30' },
      { quantity: '3', unit_price_material: '50', unit_price_labor: '10' },
    ]
    expect(sumMaterialLabor(items)).toEqual({ material: 350, labor: 90 })
  })

  it('treats note/item_description rows and missing material/labor as zero', () => {
    const items = [
      { quantity: '1', unit_price_material: '100', unit_price_labor: '20' },
      { item_type: 'note', description: 'หมายเหตุ' },
      { quantity: '2', unit_price_material: '', unit_price_labor: '' },
    ]
    expect(sumMaterialLabor(items)).toEqual({ material: 100, labor: 20 })
  })

  it('empty items list sums to zero', () => {
    expect(sumMaterialLabor([])).toEqual({ material: 0, labor: 0 })
  })
})

describe('normalizeSnapshotItems', () => {
  it('keeps an explicit item_type untouched', () => {
    const rows = [
      { description: 'a', quantity: '1', unit: 'ชุด', unit_price: '10', line_total: '10', item_type: 'item' },
      { description: 'b', quantity: '0', unit: null, unit_price: '0', line_total: '0', item_type: 'note' },
      { description: 'c', quantity: '0', unit: null, unit_price: '0', line_total: '0', item_type: 'item_description' },
    ]
    expect(normalizeSnapshotItems(rows).map(r => r.item_type)).toEqual(['item', 'note', 'item_description'])
  })

  it('infers item_description for a legacy row with no quantity, unit or price', () => {
    const rows = [
      { description: 'งานรื้อถอน', quantity: '1', unit: 'งาน', unit_price: '12000', line_total: '12000' },
      { description: 'รื้อพร้อมเตรียมหน้างาน', quantity: '0', unit: null, unit_price: '0', line_total: '0' },
      { description: 'ค่าอลูมิเนียม', quantity: 1, unit: 'ชุด', unit_price: 70000, line_total: 70000 },
      { description: 'สีเทา', quantity: 0, unit: '', unit_price: null, line_total: null },
    ]
    expect(normalizeSnapshotItems(rows).map(r => r.item_type)).toEqual(['item', 'item_description', 'item', 'item_description'])
  })

  it('keeps a legacy zero-quantity row as an item when it carries a unit or a price', () => {
    const rows = [
      { description: 'x', quantity: '0', unit: 'ชุด', unit_price: '0', line_total: '0' },
      { description: 'y', quantity: '0', unit: null, unit_price: '500', line_total: '0' },
    ]
    expect(normalizeSnapshotItems(rows).map(r => r.item_type)).toEqual(['item', 'item'])
  })

  it('returns an empty array for a missing list and does not mutate inputs', () => {
    expect(normalizeSnapshotItems(null)).toEqual([])
    const row = { description: 'z', quantity: '0', unit: null, unit_price: '0', line_total: '0' }
    normalizeSnapshotItems([row])
    expect(row.item_type).toBeUndefined()
  })
})
