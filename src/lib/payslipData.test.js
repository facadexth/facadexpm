import { describe, it, expect } from 'vitest'
import { payslipWindow, inPayslipWindow, pickYtd, pickContribBalance } from '../../supabase/functions/_shared/payslip-data.ts'

describe('payslipWindow', () => {
  it('is the current month and the 11 before it', () => {
    expect(payslipWindow('2026-10-18')).toEqual({ from: { year: 2025, month: 11 }, to: { year: 2026, month: 10 } })
  })
  it('handles January and December', () => {
    expect(payslipWindow('2026-01-05')).toEqual({ from: { year: 2025, month: 2 }, to: { year: 2026, month: 1 } })
    expect(payslipWindow('2026-12-31')).toEqual({ from: { year: 2026, month: 1 }, to: { year: 2026, month: 12 } })
  })
  it('inPayslipWindow checks both ends', () => {
    const w = payslipWindow('2026-10-18')
    expect(inPayslipWindow(w, 2025, 11)).toBe(true)
    expect(inPayslipWindow(w, 2025, 10)).toBe(false)
    expect(inPayslipWindow(w, 2026, 10)).toBe(true)
    expect(inPayslipWindow(w, 2026, 11)).toBe(false)
  })
})

describe('pickYtd', () => {
  it('sums earnings, sso and contribution like useYearToDate', () => {
    const lines = [
      { side: 'earning', amount: '1000', pay_items: { method: 'fixed' } },
      { side: 'earning', amount: 500, pay_items: null },
      { side: 'deduction', amount: 50, pay_items: { method: 'sso' } },
      { side: 'deduction', amount: '30', pay_items: { system_key: 'contribution_deduct' } },
    ]
    expect(pickYtd(lines)).toEqual({ earnings: 1500, sso: 50, contrib: 30 })
  })
  it('is zero for no lines', () => {
    expect(pickYtd([])).toEqual({ earnings: 0, sso: 0, contrib: 0 })
  })
})

describe('pickContribBalance', () => {
  it('turns the contribution_balance rpc result into a number', () => {
    expect(pickContribBalance({ data: '1140.00', error: null })).toBe(1140)
    expect(pickContribBalance({ data: 0, error: null })).toBe(0)
  })
  it('is null when the rpc failed or found nothing (the slip just leaves the line out)', () => {
    expect(pickContribBalance({ data: null, error: null })).toBeNull()
    expect(pickContribBalance({ data: '5', error: { message: 'function does not exist' } })).toBeNull()
    expect(pickContribBalance({ data: 'x', error: null })).toBeNull()
  })
})
