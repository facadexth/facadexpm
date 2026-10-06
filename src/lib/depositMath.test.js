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
    // Deposit rate 0.10/3 ≈ 0.0333; deduct 1 net -> pro-rata 0.0333 but exact remaining is 0.04
    expect(splitDeduction({ amount_no_vat: 3, vat: 0.1 }, { net: 1, vat: 0.04 }, 1)).toEqual({ net: 1, vat: 0.04 })
  })
  it('three successive deductions from net 3 / vat 0.10 sum to exactly 0.10 VAT', () => {
    const dep = { amount_no_vat: 3, vat: 0.1 }
    let remaining = { net: 3, vat: 0.1 }
    const deductions = []
    for (let i = 0; i < 3; i++) {
      const ded = splitDeduction(dep, remaining, 1)
      deductions.push({ amount_no_vat: ded.net, vat: ded.vat })
      remaining = depositRemaining(dep, deductions)
    }
    const totalVat = deductions.reduce((s, d) => s + d.vat, 0)
    expect(round2(totalVat)).toBe(0.1)
  })
})

describe('computeReceivePlan (real CAC invoices)', () => {
  it('IV6903055: 9,786 less 2,935.80 -> net 6,850.20, VAT 479.51, total 7,329.71', () => {
    // PO subtotal 9,786.00, VAT 685.02; deposit VAT rate 7% -> deduction VAT 205.51
    const p = computeReceivePlan({ subtotal: 9786, vat: 685.02 }, [{ net: 2935.8, vat: 205.51 }])
    expect(p).toEqual({ netToPay: 6850.2, vatToPay: 479.51, total: 7329.71, createExpense: true, overNet: false, overVat: false })
  })
  it('IV6903014: fully deducted -> no expense', () => {
    const p = computeReceivePlan({ subtotal: 41004, vat: 2870.28 }, [{ net: 41004, vat: 2870.28 }])
    expect(p).toEqual({ netToPay: 0, vatToPay: 0, total: 0, createExpense: false, overNet: false, overVat: false })
  })
  it('no deductions behaves like today', () => {
    expect(computeReceivePlan({ subtotal: 100, vat: 7 }, [])).toEqual({ netToPay: 100, vatToPay: 7, total: 107, createExpense: true, overNet: false, overVat: false })
  })
  it('VAT-bearing deposit on a PO with vat 0 -> overVat true', () => {
    const p = computeReceivePlan({ subtotal: 100, vat: 0 }, [{ net: 50, vat: 5 }])
    expect(p.overVat).toBe(true)
    expect(p.overNet).toBe(false)
  })
  it('deduction net exceeds PO net -> overNet true', () => {
    const p = computeReceivePlan({ subtotal: 100, vat: 10 }, [{ net: 110, vat: 5 }])
    expect(p.overNet).toBe(true)
    expect(p.overVat).toBe(false)
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
  it('fails closed with bad_limits when remainingNet or uncoveredNet is not finite', () => {
    expect(validateDeduction({ ...ok, remainingNet: NaN })).toBe('bad_limits')
    expect(validateDeduction({ ...ok, remainingNet: Infinity })).toBe('bad_limits')
    expect(validateDeduction({ ...ok, uncoveredNet: NaN })).toBe('bad_limits')
    expect(validateDeduction({ ...ok, uncoveredNet: Infinity })).toBe('bad_limits')
  })
})

describe('deposit ref matching', () => {
  it('normalizes case, spaces, dashes, and other separators', () => {
    expect(normalizeDepositRef(' AI-6901 007 ')).toBe('ai6901007')
    expect(normalizeDepositRef('AI#6901:007(A)')).toBe('ai6901007a')
  })
  it('matches the printed ref to a registered deposit', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: 'AI6901007' }, { id: 'd2', deposit_invoice_no: 'AI6901008' }]
    expect(matchDepositByRef('AI 6901007', deps).id).toBe('d1')
    expect(matchDepositByRef('AI9999999', deps)).toBeNull()
    expect(matchDepositByRef('', deps)).toBeNull()
  })
  it('does not match when digit sequence differs', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: 'AI6901007' }]
    expect(matchDepositByRef('AI69010070', deps)).toBeNull()
    expect(matchDepositByRef('AI 6901 007', deps).id).toBe('d1')
  })
  it('returns null when ref is only separators', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: 'AI6901007' }]
    expect(matchDepositByRef('---__//', deps)).toBeNull()
  })
  it('does not match a deposit with blank deposit_invoice_no', () => {
    const deps = [{ id: 'd1', deposit_invoice_no: '' }]
    expect(matchDepositByRef('AI6901007', deps)).toBeNull()
  })
  it('returns null when match is ambiguous (multiple deposits)', () => {
    const deps = [
      { id: 'd1', deposit_invoice_no: 'AI6901007' },
      { id: 'd2', deposit_invoice_no: 'AI 6901 007' }
    ]
    expect(matchDepositByRef('AI6901007', deps)).toBeNull()
  })
  it('filters by supplierId when given', () => {
    const deps = [
      { id: 'd1', deposit_invoice_no: 'AI6901007', supplier_id: 's1' },
      { id: 'd2', deposit_invoice_no: 'AI6901007', supplier_id: 's2' }
    ]
    expect(matchDepositByRef('AI6901007', deps, 's1').id).toBe('d1')
    expect(matchDepositByRef('AI6901007', deps, 's2').id).toBe('d2')
    expect(matchDepositByRef('AI6901007', deps, 's3')).toBeNull()
  })
})
