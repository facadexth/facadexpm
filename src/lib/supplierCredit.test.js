import { describe, it, expect } from 'vitest'
import {
  creditTermDays, paymentMethodOptions, billingDueTargetField,
  calcDueDate, resolvePaymentMethodOnSupplierChange,
} from './supplierCredit.js'

describe('creditTermDays', () => {
  it('returns null when no supplier is selected', () => {
    expect(creditTermDays(undefined)).toBeNull()
  })

  it('returns null when supplier.credit_days is null (cash-like)', () => {
    expect(creditTermDays({ credit_days: null })).toBeNull()
  })

  it('returns 0 when supplier.credit_days is 0, not null', () => {
    // regression guard: `?? null` must not treat 0 as "unset"
    expect(creditTermDays({ credit_days: 0 })).toBe(0)
  })

  it('returns the supplier credit_days when set', () => {
    expect(creditTermDays({ credit_days: 30 })).toBe(30)
  })
})

describe('paymentMethodOptions', () => {
  it('allows all four methods when no supplier is selected yet', () => {
    expect(paymentMethodOptions(undefined)).toEqual(['transfer', 'check', 'cash', 'credit'])
  })

  it('allows all four methods when the supplier has credit terms', () => {
    expect(paymentMethodOptions({ credit_days: 30 })).toEqual(['transfer', 'check', 'cash', 'credit'])
  })

  it('excludes check and credit when the supplier has no credit terms', () => {
    expect(paymentMethodOptions({ credit_days: null })).toEqual(['transfer', 'cash'])
  })

  it('allows all four when credit_days is 0 (still "has credit terms", just 0 days)', () => {
    expect(paymentMethodOptions({ credit_days: 0 })).toEqual(['transfer', 'check', 'cash', 'credit'])
  })
})

describe('billingDueTargetField', () => {
  it('targets check_date for check payments', () => {
    expect(billingDueTargetField('check')).toBe('check_date')
  })

  it('targets due_date for credit payments', () => {
    expect(billingDueTargetField('credit')).toBe('due_date')
  })

  it('targets due_date for any other/unset payment method', () => {
    expect(billingDueTargetField('transfer')).toBe('due_date')
    expect(billingDueTargetField(undefined)).toBe('due_date')
  })
})

describe('calcDueDate', () => {
  it('adds the credit term days to the billing date', () => {
    expect(calcDueDate('2026-08-01', 30)).toBe('2026-08-31')
  })

  it('handles a 0-day credit term (due date == billing date)', () => {
    expect(calcDueDate('2026-08-01', 0)).toBe('2026-08-01')
  })

  it('rolls over month/year boundaries correctly', () => {
    expect(calcDueDate('2026-12-15', 30)).toBe('2027-01-14')
  })
})

describe('resolvePaymentMethodOnSupplierChange', () => {
  it('resets check to transfer when the new supplier has no credit terms', () => {
    expect(resolvePaymentMethodOnSupplierChange('check', false)).toBe('transfer')
  })

  it('resets credit to transfer when the new supplier has no credit terms', () => {
    expect(resolvePaymentMethodOnSupplierChange('credit', false)).toBe('transfer')
  })

  it('leaves check/credit untouched when the new supplier has credit terms', () => {
    expect(resolvePaymentMethodOnSupplierChange('check', true)).toBe('check')
    expect(resolvePaymentMethodOnSupplierChange('credit', true)).toBe('credit')
  })

  it('leaves transfer/cash untouched regardless of the new supplier', () => {
    expect(resolvePaymentMethodOnSupplierChange('transfer', false)).toBe('transfer')
    expect(resolvePaymentMethodOnSupplierChange('cash', false)).toBe('cash')
  })
})
