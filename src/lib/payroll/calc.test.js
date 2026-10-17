import { describe, it, expect } from 'vitest'
import { calculateWorkerPay, validatePayItems, dailyRate, advanceInstallmentDue } from './calc.js'
import { DEFAULT_PAY_ITEMS as ITEMS } from './defaultItems.js'

const monthly = (over = {}) => ({ id: 'w', pay_type: 'monthly', monthly_salary: 25145, daily_wage: null, has_social_security: true, ...over })
const amountOf = (res, id) => res.lines.filter(l => l.pay_item_id === id).reduce((s, l) => s + l.amount, 0)

describe('dailyRate', () => {
  it('is salary/30 for monthly and daily_wage for daily', () => {
    expect(dailyRate(monthly({ monthly_salary: 30000 }))).toBe(1000)
    expect(dailyRate({ pay_type: 'daily', daily_wage: 200 })).toBe(200)
  })
})

describe('calculateWorkerPay', () => {
  it('ceils OT to whole baht (กอล์ฟ 1.5h → 141)', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 14980 }), attendance: { otHours: 1.5 } })
    expect(amountOf(r, 'ot')).toBe(141)
  })
  it('adds the holiday premium into OT', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 30000 }), attendance: { holidayShifts: 2 }, settings: { holidayMultiplier: 1.5 } })
    expect(amountOf(r, 'ot')).toBe(1500) // 2 × 1000 × 0.5 × 1.5
  })
  it('ceils the daily rate for unpaid leave (กร 2 days → 1678)', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly(), attendance: { leavePersonalDays: 2 } })
    expect(amountOf(r, 'unpaid_leave')).toBe(1678)
  })
  it('never deducts sick leave', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly(), attendance: { leaveSickDays: 3 } })
    expect(amountOf(r, 'unpaid_leave')).toBe(0)
  })
  it('caps SSO at 875 and rounds half-up', () => {
    const big = calculateWorkerPay({ items: ITEMS, worker: monthly(), amounts: { phone: 500 } })
    expect(amountOf(big, 'sso')).toBe(875)
    const golf = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 14980 }), amounts: { phone: 500 } })
    expect(amountOf(golf, 'sso')).toBe(811) // (14980+749+500)×5% = 811.45
  })
  it('skips SSO without social security', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ has_social_security: false }) })
    expect(amountOf(r, 'sso')).toBe(0)
  })
  it('pays daily workers by days worked, no contribution, no leave line', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: { id: 'n', pay_type: 'daily', daily_wage: 200, monthly_salary: 0, has_social_security: false }, attendance: { daysWorked: 25, leavePersonalDays: 1, otHours: 2 } })
    expect(amountOf(r, 'salary')).toBe(5000)
    expect(amountOf(r, 'contribution')).toBe(0)
    expect(amountOf(r, 'unpaid_leave')).toBe(0)
    expect(amountOf(r, 'ot')).toBe(75) // 2 × 200/8 × 1.5
    expect(r.lines.find(l => l.pay_item_id === 'salary')).toMatchObject({ quantity: 25, rate: 200 })
  })
  it('warns when a daily worker has no wage', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: { id: 'n', pay_type: 'daily', daily_wage: null, has_social_security: false }, attendance: { daysWorked: 3 } })
    expect(r.warnings).toContain('missing_daily_wage')
  })
  it('keeps manual values, including an explicit 0 advance override', () => {
    const r = calculateWorkerPay({
      items: ITEMS, worker: monthly(),
      manual: { student_loan: 500, 'advances:a1': 0 },
      advancesDue: [{ advance_id: 'a1', title: 'ค่าตำรวจ', amount: 1000, installment_no: 5, installments: 10 }],
    })
    expect(amountOf(r, 'student_loan')).toBe(500)
    const adv = r.lines.find(l => l.advance_id === 'a1')
    expect(adv).toMatchObject({ amount: 0, is_manual: true, note: 'ค่าตำรวจ งวด 5/10' })
  })
  it('drops zero lines that are not manual, and derives net', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 10000, has_social_security: false }) })
    expect(r.lines.map(l => l.pay_item_id)).toEqual(['salary', 'contribution', 'contribution_deduct'])
    expect(r.totals).toEqual({ earnings: 10500, deductions: 500, net: 10000 })
  })
  it('flags negative net', () => {
    const r = calculateWorkerPay({ items: ITEMS, worker: monthly({ monthly_salary: 1000 }), manual: { student_loan: 5000 } })
    expect(r.warnings).toContain('negative_net')
  })
  it('ignores inactive items', () => {
    const items = ITEMS.map(i => i.id === 'contribution' ? { ...i, active: false } : i)
    const r = calculateWorkerPay({ items, worker: monthly({ monthly_salary: 10000, has_social_security: false }) })
    expect(r.totals.net).toBe(10000)
    expect(amountOf(r, 'contribution_deduct')).toBe(0)
  })
})

describe('validatePayItems', () => {
  it('rejects a percent cycle and a reference to SSO', () => {
    const a = { id: 'a', method: 'percent_of_item', params: { of_item_id: 'b' } }
    const b = { id: 'b', method: 'percent_of_item', params: { of_item_id: 'a' } }
    expect(validatePayItems([a, b]).map(e => e.code)).toContain('cycle')
    const c = { id: 'c', method: 'percent_of_item', params: { of_item_id: 'sso' } }
    expect(validatePayItems([...ITEMS, c]).map(e => e.code)).toContain('bad_ref')
    expect(validatePayItems(ITEMS)).toEqual([])
  })
})

describe('advanceInstallmentDue', () => {
  it('splits evenly and puts the remainder on the last installment', () => {
    expect(advanceInstallmentDue({ amount: 10000, installments: 3, deductedBefore: 0, installmentsBefore: 0 })).toEqual({ amount: 3333.33, installment_no: 1, remaining_after: 6666.67 })
    expect(advanceInstallmentDue({ amount: 10000, installments: 3, deductedBefore: 6666.66, installmentsBefore: 2 })).toEqual({ amount: 3333.34, installment_no: 3, remaining_after: 0 })
  })
  it('returns null when fully deducted', () => {
    expect(advanceInstallmentDue({ amount: 1000, installments: 1, deductedBefore: 1000, installmentsBefore: 1 })).toBeNull()
  })
  it('keeps deducting the remainder after a skipped month', () => {
    expect(advanceInstallmentDue({ amount: 10000, installments: 10, deductedBefore: 9000, installmentsBefore: 9 })).toEqual({ amount: 1000, installment_no: 10, remaining_after: 0 })
  })
})
