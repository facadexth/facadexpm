import { describe, it, expect } from 'vitest'
import { buildCreditLinesFromPo, validateReturnQty, defaultSelection, selectionFromSavedLines, describeCreditNoteConfirm } from './creditNotePo.js'
import { computeCreditNoteTotals } from './creditNoteCalc.js'

const po = {
  purchase_order_items: [
    { id: 'a', inventory_item_id: null, description: 'fee', quantity: 3, unit: 'งาน', unit_price: 100, line_total: 300 },
    { id: 'b', inventory_item_id: 'c', description: 'cement', quantity: 2, unit: 'ถุง', unit_price: 500, discount_pct: 10 },
    { id: 'c', inventory_item_id: 'al', aluminum_profile_id: 'p', description: 'rod', quantity: 10, unit: 'เส้น', unit_price: 720, line_total: 7200, rod_length_m: 6 },
  ],
}
const lookups = {
  inventoryItems: [
    { id: 'c', base_unit: 'kg' },
    { id: 'al', base_unit: 'kg', unit_conversion_mode: 'aluminum_profile' },
  ],
  aluminumProfiles: [{ id: 'p', default_length_m: 6, linear_weight_kg_per_m: 1.2 }],
  unitFactors: [{ inventory_item_id: 'c', unit_name: 'ถุง', factor_to_base: 25 }],
}
const sel = o => Object.fromEntries(Object.entries(o).map(([k, [checked, qty]]) => [k, { checked, qty: String(qty) }]))

describe('buildCreditLinesFromPo', () => {
  it('nothing ticked -> no lines', () => {
    expect(buildCreditLinesFromPo(po, defaultSelection(po), lookups)).toEqual([])
  })
  it('full quantity non-stock line', () => {
    const l = buildCreditLinesFromPo(po, sel({ a: [true, 3] }), lookups)
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ inventory_item_id: null, quantity: 3, unit: 'งาน', unit_price: 100 })
  })
  it('partial qty with discount, base-unit conversion', () => {
    // 2 bags @500 -10% = 900, 450/bag; return 1 bag = 25 kg for 450 => 18/kg
    const l = buildCreditLinesFromPo(po, sel({ b: [true, 1] }), lookups)
    expect(l[0]).toMatchObject({ quantity: 25, unit: 'kg', unit_price: 18 })
  })
  it('aluminium: 10 rods = 72 kg at 100/kg; 5 rods = 36 kg at same price', () => {
    expect(buildCreditLinesFromPo(po, sel({ c: [true, 10] }), lookups)[0]).toMatchObject({ quantity: 72, unit: 'kg', unit_price: 100 })
    expect(buildCreditLinesFromPo(po, sel({ c: [true, 5] }), lookups)[0]).toMatchObject({ quantity: 36, unit: 'kg', unit_price: 100 })
  })
  it('skips unticked and invalid rows', () => {
    expect(buildCreditLinesFromPo(po, sel({ a: [false, 3], b: [true, 5], c: [true, 0] }), lookups)).toEqual([])
  })
})

describe('validateReturnQty', () => {
  it('rejects above ordered and non-positive, ignores unticked', () => {
    const e = validateReturnQty(sel({ a: [true, 4], b: [true, 0], c: [false, 99] }), po)
    expect(e.map(x => [x.itemId, x.reason])).toEqual([['a', 'above_ordered'], ['b', 'not_positive']])
  })
  it('accepts full and partial', () => {
    expect(validateReturnQty(sel({ a: [true, 3], b: [true, 0.5] }), po)).toEqual([])
  })
})

describe('selectionFromSavedLines', () => {
  it('restores ticked rows and partial qty from base-unit lines', () => {
    const s = selectionFromSavedLines(po, [{ inventory_item_id: 'al', description: 'rod', quantity: 36 }], lookups)
    expect(s.c).toEqual({ checked: true, qty: '5' })
    expect(s.a.checked).toBe(false)
  })
  it('returns null when a line is not from the PO', () => {
    expect(selectionFromSavedLines(po, [{ inventory_item_id: null, description: 'other', quantity: 1 }], lookups)).toBeNull()
  })
})

describe('VAT-inclusive PO totals', () => {
  it('lines feed computeCreditNoteTotals with the PO flags', () => {
    const l = buildCreditLinesFromPo(po, sel({ a: [true, 3] }), lookups)
    expect(computeCreditNoteTotals(l, { vatEnabled: true, vatRate: 0.07, priceIncludesVat: true })).toEqual({ amount_no_vat: 280.37, vat: 19.63, amount: 300 })
  })
})

describe('describeCreditNoteConfirm', () => {
  it('uses expense_date month over doc date and lists stock + shortfalls', () => {
    const d = describeCreditNoteConfirm({
      docNumber: 'CN1', siteName: 'S', amount: 1070, docDate: '2026-10-06', expenseDate: '2026-09-15',
      lines: [{ inventory_item_id: 'i', description: 'x', quantity: 5, unit: 'kg' }, { inventory_item_id: null, description: 'fee', quantity: 1 }],
      shortfalls: [{ inventory_item_id: 'i', requested: 5, onHand: 2 }], itemNameById: { i: 'Cement' },
    })
    expect(d.month).toBe('2026-09')
    expect(d.stockTexts).toEqual(['Cement × 5 kg'])
    expect(d.shortTexts[0]).toContain('คงเหลือ 2')
    expect(d.amountText).toBe('1,070.00')
  })
})
