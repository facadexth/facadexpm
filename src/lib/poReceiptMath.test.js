// src/lib/poReceiptMath.test.js
import { describe, it, expect } from 'vitest'
import { outstandingItems, receiptValue, deductionFromInput, defaultDeduction, computeReceiveDeductions } from './poReceiptMath.js'

const exclPo = { hasVat: true, priceIncludesVat: false, items: [
  { id: 'A1', line_total: 60000 }, { id: 'A2', line_total: 40000 },
] }
const dep30 = { amount_no_vat: 30000, vat: 2100 }   // 30 % of 107,000

describe('outstandingItems', () => {
  it('drops received lines', () => {
    expect(outstandingItems(exclPo.items, new Set(['A1'])).map(i => i.id)).toEqual(['A2'])
    expect(outstandingItems(exclPo.items, undefined).length).toBe(2)
  })
})

describe('receiptValue', () => {
  it('first of two receipts is the chosen lines only', () => {
    const r = receiptValue({ ...exclPo, lineIds: ['A1'], receivedItemIds: new Set(), priorReceipts: [] })
    expect(r).toEqual({ subtotal: 60000, vat: 4200, total: 64200, isFinal: false })
  })
  it('final receipt = PO minus earlier receipts', () => {
    const r = receiptValue({ ...exclPo, lineIds: ['A2'], receivedItemIds: new Set(['A1']), priorReceipts: [{ goods_subtotal: 60000, goods_vat: 4200 }] })
    expect(r).toEqual({ subtotal: 40000, vat: 2800, total: 42800, isFinal: true })
  })
  it('incl-VAT final receipt absorbs the rounding so the PO adds up', () => {
    const items = [{ id: 'X', line_total: 100 }, { id: 'Y', line_total: 200 }]
    const first = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['X'], receivedItemIds: new Set(), priorReceipts: [] })
    expect(first).toEqual({ subtotal: 93.46, vat: 6.54, total: 100, isFinal: false })
    const last = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['Y'], receivedItemIds: new Set(['X']), priorReceipts: [{ goods_subtotal: 93.46, goods_vat: 6.54 }] })
    expect(last).toEqual({ subtotal: 186.91, vat: 13.09, total: 200, isFinal: true })
  })
  it('no VAT', () => {
    expect(receiptValue({ items: exclPo.items, hasVat: false, priceIncludesVat: false, lineIds: ['A1'], receivedItemIds: new Set(), priorReceipts: [] }))
      .toEqual({ subtotal: 60000, vat: 0, total: 60000, isFinal: false })
  })
  it('nothing chosen is not final', () => {
    expect(receiptValue({ ...exclPo, lineIds: [], receivedItemIds: new Set(), priorReceipts: [] }).isFinal).toBe(false)
  })
})

describe('deductionFromInput', () => {
  const remaining = { net: 30000, vat: 2100 }
  it('value 19,260 -> 18,000 + 1,260', () => {
    expect(deductionFromInput({ mode: 'value', value: '19260', receiptTotal: 64200, deposit: dep30, remaining }))
      .toEqual({ code: null, gross: 19260, net: 18000, vat: 1260 })
  })
  it('percent of this receipt incl. VAT', () => {
    expect(deductionFromInput({ mode: 'percent', value: '30', receiptTotal: 64200, deposit: dep30, remaining }))
      .toEqual({ code: null, gross: 19260, net: 18000, vat: 1260 })
  })
  it('whole remaining takes the exact remainder (R5)', () => {
    expect(deductionFromInput({ mode: 'value', value: '12840', receiptTotal: 42800, deposit: dep30, remaining: { net: 12000, vat: 840 } }))
      .toEqual({ code: null, gross: 12840, net: 12000, vat: 840 })
  })
  it('ไทย-เยอรมัน: 110,600.55 = 103,365.00 + 7,235.55', () => {
    const dep = { amount_no_vat: 103365, vat: 7235.55 }
    expect(deductionFromInput({ mode: 'value', value: '110600.55', receiptTotal: 221201.10, deposit: dep, remaining: { net: 103365, vat: 7235.55 } }))
      .toEqual({ code: null, gross: 110600.55, net: 103365, vat: 7235.55 })
  })
  it('deductionFromInput errors', () => {
    const base = { receiptTotal: 64200, deposit: dep30, remaining }
    expect(deductionFromInput({ ...base, mode: 'value', value: '' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'value', value: '0' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'value', value: 'abc' }).code).toBe('not_positive')
    expect(deductionFromInput({ ...base, mode: 'percent', value: '101' }).code).toBe('bad_percent')
    expect(deductionFromInput({ ...base, mode: 'value', value: '32100.01' }).code).toBe('exceeds_remaining')
    expect(deductionFromInput({ ...base, receiptTotal: 1000, mode: 'value', value: '1000.01' }).code).toBe('exceeds_receipt')
  })
})

describe('defaultDeduction (R4)', () => {
  it('own deposit, non-final: deposit share x receipt', () => {
    expect(defaultDeduction({ own: true, depositGross: 32100, poTotal: 107000, remaining: { net: 30000, vat: 2100 }, receiptTotal: 64200, isFinal: false })).toBe('19260')
  })
  it('own deposit, final: whole remaining', () => {
    expect(defaultDeduction({ own: true, depositGross: 32100, poTotal: 107000, remaining: { net: 12000, vat: 840 }, receiptTotal: 42800, isFinal: true })).toBe('12840')
  })
  it('capped by the receipt', () => {
    expect(defaultDeduction({ own: true, depositGross: 100, poTotal: 100, remaining: { net: 93.46, vat: 6.54 }, receiptTotal: 40, isFinal: true })).toBe('40')
  })
  it('legacy deposit: min(remaining, room)', () => {
    expect(defaultDeduction({ own: false, depositGross: 5350, poTotal: 0, remaining: { net: 5000, vat: 350 }, receiptTotal: 64200, isFinal: false, alreadyCovered: 62000 })).toBe('2200')
  })
  it('nothing left -> empty string', () => {
    expect(defaultDeduction({ own: true, depositGross: 100, poTotal: 100, remaining: { net: 0, vat: 0 }, receiptTotal: 50, isFinal: true })).toBe('')
  })
})

describe('computeReceiveDeductions', () => {
  const own = { id: 'd-own', supplier_id: 'S', expense: dep30, remaining: { net: 30000, vat: 2100 } }
  const other = { id: 'd-other', supplier_id: 'S2', expense: { amount_no_vat: 100, vat: 7 }, remaining: { net: 100, vat: 7 } }
  const receipt = { subtotal: 60000, vat: 4200, total: 64200, isFinal: false }
  it('builds the RPC payload and the bill preview', () => {
    const r = computeReceiveDeductions({ deposits: [own], supplierId: 'S', selection: { 'd-own': { checked: true, mode: 'value', value: '19260' } }, receipt })
    expect(r.valid).toBe(true)
    expect(r.deductions).toEqual([{ deposit_id: 'd-own', mode: 'value', value: 19260 }])
    expect(r.lines['d-own']).toEqual({ gross: 19260, net: 18000, vat: 1260 })
    expect(r.plan).toMatchObject({ netToPay: 42000, vatToPay: 2940, total: 44940, createExpense: true })
  })
  it('two receipts use the deposit up exactly', () => {
    const r2 = computeReceiveDeductions({ deposits: [{ ...own, remaining: { net: 12000, vat: 840 } }], supplierId: 'S',
      selection: { 'd-own': { checked: true, mode: 'value', value: '12840' } }, receipt: { subtotal: 40000, vat: 2800, total: 42800, isFinal: true } })
    expect(r2.lines['d-own']).toEqual({ gross: 12840, net: 12000, vat: 840 })
    expect(r2.plan).toMatchObject({ netToPay: 28000, vatToPay: 1960, total: 29960 })
  })
  it('full cover -> no bill', () => {
    const dep = { id: 'd', supplier_id: 'S', expense: { amount_no_vat: 103365, vat: 7235.55 }, remaining: { net: 103365, vat: 7235.55 } }
    const r = computeReceiveDeductions({ deposits: [dep], supplierId: 'S', selection: { d: { checked: true, mode: 'value', value: '110600.55' } },
      receipt: { subtotal: 103365, vat: 7235.55, total: 110600.55, isFinal: true } })
    expect(r.plan.createExpense).toBe(false)
  })
  it('errors: wrong supplier, too large, unchecked ignored', () => {
    const r = computeReceiveDeductions({ deposits: [own, other], supplierId: 'S',
      selection: { 'd-own': { checked: true, mode: 'value', value: '99999' }, 'd-other': { checked: true, mode: 'value', value: '10' } }, receipt })
    expect(r.errors).toEqual({ 'd-own': 'exceeds_remaining', 'd-other': 'wrong_supplier' })
    expect(r.valid).toBe(false)
    const none = computeReceiveDeductions({ deposits: [own], supplierId: 'S', selection: { 'd-own': { checked: false, mode: 'value', value: '1' } }, receipt })
    expect(none.deductions).toEqual([])
    expect(none.plan.total).toBe(64200)
  })
})
