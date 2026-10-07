// src/lib/poReceiptMath.test.js
import { describe, it, expect } from 'vitest'
import { outstandingItems, receiptValue, deductionFromInput, defaultDeduction, computeReceiveDeductions, receiptRange, toleratedReceiptPlan } from './poReceiptMath.js'
import { calcPoTotals } from './poTotals.js'

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
    expect(r).toEqual({ subtotal: 60000, vat: 4200, total: 64200, isFinal: false, priorCount: 0 })
  })
  it('final receipt = PO minus earlier receipts', () => {
    const r = receiptValue({ ...exclPo, lineIds: ['A2'], receivedItemIds: new Set(['A1']), priorReceipts: [{ goods_subtotal: 60000, goods_vat: 4200 }] })
    expect(r).toEqual({ subtotal: 40000, vat: 2800, total: 42800, isFinal: true, priorCount: 1 })
  })
  it('incl-VAT final receipt absorbs the rounding so the PO adds up', () => {
    const items = [{ id: 'X', line_total: 100 }, { id: 'Y', line_total: 200 }]
    const first = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['X'], receivedItemIds: new Set(), priorReceipts: [] })
    expect(first).toEqual({ subtotal: 93.46, vat: 6.54, total: 100, isFinal: false, priorCount: 0 })
    const last = receiptValue({ items, hasVat: true, priceIncludesVat: true, lineIds: ['Y'], receivedItemIds: new Set(['X']), priorReceipts: [{ goods_subtotal: 93.46, goods_vat: 6.54 }] })
    expect(last).toEqual({ subtotal: 186.91, vat: 13.09, total: 200, isFinal: true, priorCount: 1 })
  })
  it('no VAT', () => {
    expect(receiptValue({ items: exclPo.items, hasVat: false, priceIncludesVat: false, lineIds: ['A1'], receivedItemIds: new Set(), priorReceipts: [] }))
      .toEqual({ subtotal: 60000, vat: 0, total: 60000, isFinal: false, priorCount: 0 })
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
  it('deposit 100 + 6.99 used in full vs receipt 100 + 7: no fold above the deposit VAT -> 0.01 bill (= receive_po_lines)', () => {
    const dep = { id: 'd', supplier_id: 'S', expense: { amount_no_vat: 100, vat: 6.99 }, remaining: { net: 100, vat: 6.99 } }
    const r = computeReceiveDeductions({ deposits: [dep], supplierId: 'S', selection: { d: { checked: true, mode: 'value', value: '106.99' } },
      receipt: { subtotal: 100, vat: 7, total: 107, isFinal: true } })
    expect(r.lines.d).toEqual({ gross: 106.99, net: 100, vat: 6.99 })
    expect(r.plan).toMatchObject({ netToPay: 0, vatToPay: 0.01, total: 0.01, createExpense: true })
    expect(r.valid).toBe(true)
  })
})

describe('final remainder below 0 from satang rounding (= receive_po_lines tolerance)', () => {
  const items = [{ id: 'a', line_total: 150.5 }, { id: 'b', line_total: 150.5 }, { id: 'c', line_total: 0 }]
  const goods = r => ({ goods_subtotal: r.subtotal, goods_vat: r.vat })
  const r1 = receiptValue({ items, hasVat: true, priceIncludesVat: false, lineIds: ['a'], receivedItemIds: new Set(), priorReceipts: [] })
  const r2 = receiptValue({ items, hasVat: true, priceIncludesVat: false, lineIds: ['b'], receivedItemIds: new Set(['a']), priorReceipts: [goods(r1)] })
  const r3 = receiptValue({ items, hasVat: true, priceIncludesVat: false, lineIds: ['c'], receivedItemIds: new Set(['a', 'b']), priorReceipts: [goods(r1), goods(r2)] })
  it('two deliveries round VAT up (10.535 -> 10.54); the free last line is worth 0.00 / -0.01', () => {
    expect([r1.subtotal, r1.vat, r2.subtotal, r2.vat]).toEqual([150.5, 10.54, 150.5, 10.54])
    expect(r3).toMatchObject({ subtotal: 0, vat: -0.01, isFinal: true, priorCount: 2 })
  })
  it('without deductions: accepted, no bill', () => {
    const r = computeReceiveDeductions({ deposits: [], supplierId: 'S', selection: {}, receipt: r3 })
    expect(r.valid).toBe(true)
    expect(r.receiptBad).toBe(false)
    expect(r.plan.createExpense).toBe(false)
  })
  it('with a deduction the receipt cannot be used', () => {
    const dep = { id: 'd', supplier_id: 'S', expense: { amount_no_vat: 100, vat: 7 }, remaining: { net: 100, vat: 7 } }
    const r = computeReceiveDeductions({ deposits: [dep], supplierId: 'S', selection: { d: { checked: true, mode: 'value', value: '1' } }, receipt: r3 })
    expect(r.valid).toBe(false)
    expect(receiptRange(r3, true).bad).toBe(true)
  })
  it('beyond -0.01 per earlier receipt, or on a non-final receipt, is refused', () => {
    expect(receiptRange({ subtotal: 0, vat: -0.02, isFinal: true, priorCount: 1 }, false).bad).toBe(true)
    expect(receiptRange({ subtotal: 0, vat: -0.01, isFinal: true, priorCount: 1 }, false)).toEqual({ bad: false, tolerated: true })
    expect(receiptRange({ subtotal: 0, vat: -0.01, isFinal: false, priorCount: 0 }, false).bad).toBe(true)
  })
  it('a tolerated remainder still worth something bills the payable total, never a negative field', () => {
    expect(toleratedReceiptPlan({ subtotal: 5, vat: -0.01 })).toEqual({ netToPay: 4.99, vatToPay: 0, total: 4.99, createExpense: true, overNet: false, overVat: false })
    expect(toleratedReceiptPlan({ subtotal: -0.01, vat: 0.35 })).toMatchObject({ netToPay: 0, vatToPay: 0.34, total: 0.34 })
    expect(toleratedReceiptPlan({ subtotal: -0.01, vat: 0.01 }).createExpense).toBe(false)
  })
  it('property: receiving line by line always adds up to the PO exactly and every receipt is accepted', () => {
    const sets = [[150.5, 150.5, 0], [0.05, 0.05, 0.05, 0], [33.33, 33.33, 33.34], [0.07, 0.07, 0.07, 0.07], [10.15, 20.25, 0], [0.15, 0.15, 0.15, 0.15, 0.15, 0], [99.99, 0.01, 0, 0]]
    for (const amounts of sets) {
      for (const incl of [false, true]) {
        const its = amounts.map((v, i) => ({ id: 'l' + i, line_total: v }))
        const prior = []
        const got = new Set()
        for (const it of its) {
          const r = receiptValue({ items: its, hasVat: true, priceIncludesVat: incl, lineIds: [it.id], receivedItemIds: new Set(got), priorReceipts: [...prior] })
          const res = computeReceiveDeductions({ deposits: [], supplierId: 'S', selection: {}, receipt: r })
          expect(res.valid, `${amounts} incl=${incl} line ${it.id}`).toBe(true)
          prior.push({ goods_subtotal: r.subtotal, goods_vat: r.vat })
          got.add(it.id)
        }
        const po = calcPoTotals(its, true, incl)
        const sumSub = Math.round(prior.reduce((s, r) => s + r.goods_subtotal, 0) * 100) / 100
        const sumVat = Math.round(prior.reduce((s, r) => s + r.goods_vat, 0) * 100) / 100
        expect(sumSub, `${amounts} incl=${incl}`).toBe(Math.round(po.subtotal * 100) / 100)
        expect(sumVat, `${amounts} incl=${incl}`).toBe(po.vat)
      }
    }
  })
})
