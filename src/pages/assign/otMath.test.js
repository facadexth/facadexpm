import { describe, it, expect } from 'vitest'
import { workerDayRate, otCost } from './otMath.js'

describe('workerDayRate', () => {
  it('uses monthly_salary / 30 for monthly workers', () => {
    expect(workerDayRate({ monthly_salary: 15000 })).toBe(500)
  })
  it('uses daily_wage for daily workers', () => {
    expect(workerDayRate({ pay_type: 'daily', daily_wage: 450, monthly_salary: 0 })).toBe(450)
    expect(workerDayRate({ pay_type: 'daily', daily_wage: null })).toBe(0)
  })
})

describe('otCost', () => {
  it('keeps the legacy monthly-salary number form', () => {
    expect(otCost(24000, 2)).toBe(300)
  })
  it('takes a worker object so daily workers use daily_wage', () => {
    expect(otCost({ pay_type: 'daily', daily_wage: 400 }, 2)).toBe(150)
  })
})
