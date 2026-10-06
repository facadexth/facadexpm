import { describe, it, expect } from 'vitest'
import { round2, depositRemaining, splitDeduction, computeReceivePlan, validateDeduction, normalizeDepositRef, matchDepositByRef } from './depositMath.js'

describe('depositRemaining', () => {
  it('subtracts applications from net and vat', () => {
    expect(depositRemaining({ amount_no_vat: 1000, vat: 70 }, [{ amount_no_vat: 400, vat: 28 }])).toEqual({ net: 600, vat: 42 })
  })
  it('is the full deposit with no applications', () => {
    expect(depositRemaining({ amount_no_vat: 212754.6, vat: 14892.82 }, [])).toEqual({ net: 212754.6, vat: 14892.82 })
  })
})

describe('splitDeduction', () => {
  const dep = { amount_no_vat: 1000, vat: 70 }
  it('takes VAT pro-rata at the deposit rate', () => {
    expect(splitDeduction(dep, { net: 1000, vat: 70 }, 2935.8 / 10)).toEqual({ net: 293.58, vat: 20.55 })
  })
  it('takes the exact remaining VAT when it uses up the whole remaining net', () => {
    expect(splitDeduction({ amount_no_vat: 3, vat: 0.21 }, { net: 1, vat: 0.07 }, 1)).toEqual({ net: 1, vat: 0.07 })
  })
})

describe('computeReceivePlan (real CAC invoices)', () => {
  it('IV6903055: 9,786 less 2,935.80 -> net 6,850.20, VAT 479.51, total 7,329.71', () => {
    // PO subtotal 9,786.00, VAT 685.02; deposit VAT rate 7% -> deduction VAT 205.51
    const p = computeReceivePlan({ subtotal: 9786, vat: 685.02 }, [{ net: 2935.8, vat: 205.51 }])
    expect(p).toEqual({ netToPay: 6850.2, vatToPay: 479.51, total: 7329.71, createExpense: true })
  })
  it('IV6903014: fully deducted -> no expense', () => {
    const p = computeReceivePlan({ subtotal: 41004, vat: 2870.28 }, [{ net: 41004, vat: 2870.28 }])
    expect(p).toEqual({ netToPay: 0, vatToPay: 0, total: 0, createExpense: false })
  })
  it('no deductions behaves like today', () => {
    expect(computeReceivePlan({ subtotal: 100, vat: 7 }, [])).toEqual({ netToPay: 100, vatToPay: 7, total: 107, createExpense: true })
  })
})

describe('validateDeduction', () => {
  const ok = { supplierOk: true, remainingNet: 100, amountNoVat: 50, uncoveredNet: 80 }
  it('accepts a valid deduction', () => expect(validateDeduction(ok)).toBeNull())
  it('rejects other supplier', () => expect(validateDeduction({ ...ok, supplierOk: false })).toBe('wrong_supplier'))
  it('rejects zero/negative/NaN', () => {
    expect(validateDeduction({ ...ok, amountNoVat: 0 })).toBe('not_positive')
    expect(validateDeduction({ ...ok, amountNoVat: NaN })).toBe('not_positive')
  })
  it('rejects above remaining and above the PO', () => {
    expect(validateDeduction({ ...ok, amountNoVat: 100.01 })).toBe('exceeds_remaining')
    expect(validateDeduction({ ...ok, amountNoVat: 90, remainingNet: 200 })).toBe('exceeds_po')
  })
})

describe('deposit ref matching', () => {
  it('normalizes case, spaces and dashes', () => expect(normalizeDepositRef(' AI-6901 007 ')).toBe('ai6901007'))
  it('matches the printed ref to a registered deposit', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: 'AI6901007' }, { id: 'd2', deposit_invoice_no: 'AI6901008' }]
    expect(matchDepositByRef('AI 6901007', deps).id).toBe('d1')
    expect(matchDepositByRef('AI9999999', deps)).toBeNull()
    expect(matchDepositByRef('', deps)).toBeNull()
  })
})
