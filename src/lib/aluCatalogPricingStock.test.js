import { describe, it, expect } from 'vitest'
import { buildCatalogIndex, makeCatalogPricing } from './aluCatalogPricing.js'
import { priceRowLabel } from '../pages/estimation/projectDefaults.js'

const index = buildCatalogIndex({
  parts: [
    { id: 'SET', kind: 'hardware_set', name: 'ชุดบานเลื่อน' },
    { id: 'P1', kind: 'hardware', name: 'ล้อ', inventory_item_id: 'i1' },
    { id: 'P2', kind: 'accessory', name: 'ซิลิโคน' },
  ],
  setItems: [{ id: 'x1', set_id: 'SET', part_id: 'P1', quantity: 4 }, { id: 'x2', set_id: 'SET', part_id: 'P2', quantity: 1 }],
  partPrices: [{ id: 'pp2', part_id: 'P2', list_price: 95, discount_pct: 0, effective_from: '2026-01-01' }, { id: 'pp1', part_id: 'P1', list_price: 70, discount_pct: 0, effective_from: '2026-01-01' }],
  purchasePrices: [{ id: 'sti:9', inventory_item_id: 'i1', unit_cost: 85, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-9' }],
})
const lines = asOf => makeCatalogPricing({ index, seriesId: null, finishId: null, asOf }).setLines('SET')

describe('hardware set lines with a stock-linked part', () => {
  it('the linked part is priced at its latest purchase price on/before the project date', () => {
    const l = lines('2026-10-31')
    expect(l.find(x => x.name === 'ล้อ')).toMatchObject({ unit_price: 85, cost: 340, resolved: true, price_row_id: 'sti:9' })
    expect(l.find(x => x.name === 'ซิลิโคน')).toMatchObject({ unit_price: 95, price_row_id: 'pp2' })
  })
  it('a project dated before the invoice keeps the catalogue price', () => {
    expect(lines('2026-09-01').find(x => x.name === 'ล้อ')).toMatchObject({ unit_price: 70, price_row_id: 'pp1' })
  })
  it('priceRowLabel names a purchase-price row', () => {
    expect(priceRowLabel(index, 'sti:9')).toBe('85.00 บาท (ใบกำกับภาษีซื้อ IV-9 · 2026-10-01)')
  })
  it('buildCatalogIndex: purchasePrices defaults to []', () => {
    expect(buildCatalogIndex({}).purchasePrices).toEqual([])
  })
})
