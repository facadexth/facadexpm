import { describe, it, expect } from 'vitest'
import { reservedDepositTotal, availableDeposit, computeInvoiceNet, solveRawForNet } from './invoiceNet.js'

describe('reserved deposit', () => {
  it('counts only unpaid, non-deposit invoices with a chosen deduction', () => {
    const rows = [
      { status: 'unpaid', deposit_deduction_amount: '78210.00', is_deposit: false },
      { status: 'paid', deposit_deduction_amount: '5000', is_deposit: false },     // already taken from the balance
      { status: 'void', deposit_deduction_amount: '9000', is_deposit: false },     // released
      { status: 'unpaid', deposit_deduction_amount: null, is_deposit: false },     // legacy: unknown until paid
      { status: 'unpaid', deposit_deduction_amount: '1000', is_deposit: true },    // a deposit invoice never deducts
    ]
    expect(reservedDepositTotal(rows)).toBe(78210)
  })
  it('available = remaining - reserved, never negative', () => {
    expect(availableDeposit(78210, 78210)).toBe(0)
    expect(availableDeposit(78210, 30000)).toBe(48210)
    expect(availableDeposit(1000, 5000)).toBe(0)
    expect(reservedDepositTotal(null)).toBe(0)
  })
})

describe('computeInvoiceNet', () => {
  const base = { hasVat: true, priceIncludesVat: false, whtPct: 3, retentionPct: 0, availableOffset: 78210 }
  const dep = (mode, text, balance = 78210) => ({ enabled: true, mode, text, balance })

  it('whole deposit on 150,000: VAT/WHT only on 71,790, receives 74,661.60 (owner example)', () => {
    const r = computeInvoiceNet({ ...base, raw: 150000, deposit: dep('value', '78210') })
    expect(r.taxOffset).toBe(78210)
    expect(r.vat).toBe(5025.3)
    expect(r.wht).toBe(2153.7)
    expect(r.depositAmount).toBe(78210)
    expect(r.net).toBe(74661.6)
  })
  it('card lines for the owner example: 150,000 - 78,210 = 71,790; VAT 5,025.30; invoice amount 76,815.30; receives 74,661.60', () => {
    const r = computeInvoiceNet({ ...base, raw: 150000, deposit: dep('value', '78210') })
    expect(r.subtotal).toBe(150000)
    expect(r.afterDeposit).toBe(71790)
    expect(r.vat).toBe(5025.3)
    expect(r.billingTotal).toBe(76815.3)
    expect(r.wht).toBe(2153.7)
    expect(r.net).toBe(74661.6)
  })
  it('without a deposit the invoice amount is the old total', () => {
    const r = computeInvoiceNet({ ...base, raw: 100000, deposit: dep('none', ''), availableOffset: 0 })
    expect(r.afterDeposit).toBe(100000)
    expect(r.billingTotal).toBe(107000)
  })
  it('no deduction: VAT and WHT on the full value', () => {
    const r = computeInvoiceNet({ ...base, raw: 150000, deposit: dep('none', '') })
    expect(r.taxOffset).toBe(0)
    expect(r.vat).toBe(10500)
    expect(r.wht).toBe(4500)
    expect(r.net).toBe(156000)
  })
  it('deposit box hidden (legacy): keeps the old full offset', () => {
    const r = computeInvoiceNet({ ...base, raw: 150000, deposit: { enabled: false } })
    expect(r.taxOffset).toBe(78210)
    expect(r.depositAmount).toBe(0)
    expect(r.vat).toBe(5025.3)
  })
  it('retention comes off the cash received', () => {
    const r = computeInvoiceNet({ ...base, retentionPct: 5, raw: 100000, deposit: dep('none', '') })
    expect(r.retention).toBe(5000)
    expect(r.net).toBe(100000 + 7000 - 3000 - 5000)
  })
  it('a deduction is capped by the free deposit it is given', () => {
    const r = computeInvoiceNet({ ...base, raw: 150000, deposit: dep('value', '78210', 20000) })
    expect(r.depositAmount).toBe(20000)
    expect(r.taxOffset).toBe(20000)
  })
})

describe('solveRawForNet', () => {
  const base = { hasVat: true, priceIncludesVat: false, whtPct: 3, retentionPct: 0, availableOffset: 78210 }
  const dep = (mode, text, balance = 78210) => ({ enabled: true, mode, text, balance })
  const check = (params, target, max) => {
    const raw = solveRawForNet(target, params, max)
    const net = computeInvoiceNet({ ...params, raw }).net
    return { raw, net }
  }

  it('without deposit: net = raw x 1.04 (VAT 7% - WHT 3%)', () => {
    const { raw, net } = check({ ...base, deposit: { enabled: true, mode: 'none', text: '', balance: 78210 }, availableOffset: 0 }, 104000, 500000)
    expect(raw).toBeCloseTo(100000, 0)
    expect(net).toBeCloseTo(104000, 0)
  })
  it('with a whole-deposit deduction the target is the cash actually received', () => {
    const { raw, net } = check({ ...base, deposit: dep('value', '78210') }, 74661.6, 500000)
    expect(raw).toBeCloseTo(150000, 0)
    expect(net).toBeCloseTo(74661.6, 0)
  })
  it('with a % deduction the deposit moves with the solved value', () => {
    const { raw, net } = check({ ...base, deposit: dep('pct', '30') }, 100000, 500000)
    expect(net).toBeCloseTo(100000, 0)
    const r = computeInvoiceNet({ ...base, raw, deposit: dep('pct', '30') })
    expect(r.depositAmount).toBeCloseTo(raw * 0.3, 0)
  })
  it('asking for more than everything still open gives everything open', () => {
    expect(solveRawForNet(10_000_000, { ...base, deposit: dep('none', '') }, 200000)).toBe(200000)
  })
  it('zero / negative targets give 0', () => {
    expect(solveRawForNet(0, { ...base, deposit: dep('none', '') }, 200000)).toBe(0)
    expect(solveRawForNet(-5, { ...base, deposit: dep('none', '') }, 200000)).toBe(0)
  })
})
