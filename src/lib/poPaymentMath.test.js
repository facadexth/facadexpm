// src/lib/poPaymentMath.test.js
import { describe, it, expect } from 'vitest'
import { depositFromPo, splitPaymentAmounts } from './poPaymentMath.js'

describe('depositFromPo', () => {
  it('ไทย-เยอรมัน 50 % of 221,201.10', () => {
    expect(depositFromPo({ mode: 'percent', value: '50', poTotal: 221201.10, hasVat: true }))
      .toEqual({ code: null, gross: 110600.55, net: 103365, vat: 7235.55, pctOfPo: 50 })
  })
  it('amount on a VAT PO', () => {
    expect(depositFromPo({ mode: 'amount', value: '32100', poTotal: 107000, hasVat: true }))
      .toEqual({ code: null, gross: 32100, net: 30000, vat: 2100, pctOfPo: 30 })
  })
  it('no-VAT PO keeps VAT 0', () => {
    expect(depositFromPo({ mode: 'percent', value: '10', poTotal: 1000, hasVat: false }))
      .toEqual({ code: null, gross: 100, net: 100, vat: 0, pctOfPo: 10 })
  })
  it('pct keeps 4 decimals', () => {
    expect(depositFromPo({ mode: 'amount', value: '1000', poTotal: 3000, hasVat: false }).pctOfPo).toBe(33.3333)
  })
  it('errors', () => {
    expect(depositFromPo({ mode: 'percent', value: '0', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'percent', value: '100.5', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'amount', value: '', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'bogus', value: '5', poTotal: 1000, hasVat: true }).code).toBe('bad_deposit_value')
    expect(depositFromPo({ mode: 'amount', value: '1000.01', poTotal: 1000, hasVat: true }).code).toBe('deposit_exceeds_po')
  })
})

describe('splitPaymentAmounts', () => {
  it('VAT stays proportional and both parts add up', () => {
    const r = splitPaymentAmounts({ amount: 110600.55, amount_no_vat: 103365, vat: 7235.55 }, '50000')
    expect(r).toEqual({ code: null, paid: { amount: 50000, net: 46728.97, vat: 3271.03 }, rest: { amount: 60600.55, net: 56636.03, vat: 3964.52 } })
  })
  it('receipt bill 44,940 pay 20,000', () => {
    const r = splitPaymentAmounts({ amount: 44940, amount_no_vat: 42000, vat: 2940 }, 20000)
    expect(r.paid).toEqual({ amount: 20000, net: 18691.59, vat: 1308.41 })
    expect(r.rest).toEqual({ amount: 24940, net: 23308.41, vat: 1631.59 })
  })
  it('bill without VAT split splits the amount only', () => {
    expect(splitPaymentAmounts({ amount: 1000, amount_no_vat: null, vat: null }, 400))
      .toEqual({ code: null, paid: { amount: 400, net: null, vat: null }, rest: { amount: 600, net: null, vat: null } })
  })
  it('errors', () => {
    const bill = { amount: 1000, amount_no_vat: 934.58, vat: 65.42 }
    expect(splitPaymentAmounts(bill, '').code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 0).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 1000).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts(bill, 1200).code).toBe('bad_split_amount')
    expect(splitPaymentAmounts({ amount: 1000, amount_no_vat: 900, vat: 70 }, 500).code).toBe('bill_bad_split')
  })
})
