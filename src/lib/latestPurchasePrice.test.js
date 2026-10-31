import { describe, it, expect } from 'vitest'
import { latestPurchasePrice, resolveStockPartPrice, priceSourceText } from './latestPurchasePrice.js'

const rows = [
  { id: 'sti:1', inventory_item_id: 'i1', unit_cost: '98', effective_from: '2026-09-01', source: 'tax_invoice', doc_no: 'IV-1' },
  { id: 'sti:2', inventory_item_id: 'i1', unit_cost: 105, effective_from: '2026-10-20', source: 'tax_invoice', doc_no: 'IV-2' },
  { id: 'poi:1', inventory_item_id: 'i1', unit_cost: 90, effective_from: '2026-10-25', source: 'po', doc_no: 'PO-2026-010' },
  { id: 'poi:2', inventory_item_id: 'i2', unit_cost: 40, effective_from: '2026-08-01', source: 'po', doc_no: 'PO-2026-002' },
]
const partPrices = [{ id: 'pp1', part_id: 'P3', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }]

describe('latestPurchasePrice', () => {
  it('a tax invoice beats a newer PO; numbers come out as numbers', () => {
    expect(latestPurchasePrice(rows, 'i1')).toEqual({ unit_cost: 105, effective_from: '2026-10-20', source: 'tax_invoice', doc_no: 'IV-2', id: 'sti:2' })
  })
  it('never a price dated after asOf (Review Focus 4)', () => {
    expect(latestPurchasePrice(rows, 'i1', '2026-10-01').id).toBe('sti:1')
    expect(latestPurchasePrice(rows, 'i1', '2026-08-31')).toBeNull()
  })
  it('a PO when the item has no tax invoice; null for no rows or no item', () => {
    expect(latestPurchasePrice(rows, 'i2').source).toBe('po')
    expect(latestPurchasePrice(rows, 'i9')).toBeNull()
    expect(latestPurchasePrice(rows, null)).toBeNull()
  })
})

describe('resolveStockPartPrice', () => {
  it('a stock-linked part: the purchase price, in resolvePartPrice shape', () => {
    const p = resolveStockPartPrice({ partId: 'P1', part: { id: 'P1', inventory_item_id: 'i1' }, asOf: '2026-10-31', purchasePrices: rows, partPrices })
    expect(p).toEqual({ list_price: 105, discount_pct: 0, net_price: 105, row: { id: 'sti:2', effective_from: '2026-10-20' }, source: 'tax_invoice', date: '2026-10-20', doc_no: 'IV-2' })
  })
  it('falls back to the catalogue price, and an unlinked part always uses it', () => {
    expect(resolveStockPartPrice({ partId: 'P3', part: { id: 'P3', inventory_item_id: 'i9' }, asOf: '2026-10-31', purchasePrices: rows, partPrices }))
      .toMatchObject({ net_price: 90, source: 'catalog', date: '2026-01-01', doc_no: null })
    expect(resolveStockPartPrice({ partId: 'P3', part: { id: 'P3' }, asOf: '2026-10-31', purchasePrices: rows, partPrices }).source).toBe('catalog')
    expect(resolveStockPartPrice({ partId: 'P4', part: { id: 'P4' }, asOf: '2026-10-31', purchasePrices: rows, partPrices })).toBeNull()
  })
  it('priceSourceText', () => {
    expect(priceSourceText({ source: 'tax_invoice', doc_no: 'IV-2', date: '2026-10-20' })).toBe('ใบกำกับภาษีซื้อ IV-2 · 2026-10-20')
    expect(priceSourceText({ source: 'po', doc_no: 'PO-1', date: '2026-08-01' })).toBe('ใบสั่งซื้อ PO-1 · 2026-08-01')
    expect(priceSourceText({ source: 'catalog', date: '2026-01-01' })).toBe('แคตตาล็อก · ตั้งแต่ 2026-01-01')
    expect(priceSourceText(null)).toBe('ยังไม่มีราคา')
  })
})
